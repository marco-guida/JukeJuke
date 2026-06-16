const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} = require("@discordjs/voice");
const ytdl = require("@distube/ytdl-core");
const ytSearch = require("yt-search");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const musicPlaylist = new Map();
let currentPlayer = null;
const connections = new Map();

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

function logError(error, context) {
  console.error(`[${new Date().toISOString()}] Error in ${context}:`, error);
}

function validateUserInVoiceChannel(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    interaction.reply({
      content: "You need to be in a voice channel to use this command.",
      ephemeral: true,
    });
    return null;
  }
  return channel;
}

function isPlayerActive(player) {
  return player && (player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Paused);
}

function getOrCreateConnection(guildId, channel) {
  let connection = connections.get(guildId);
  if (!connection || connection.state.status === 'destroyed') {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    connections.set(guildId, connection);
  }
  return connection;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === "join") {
    const channel = validateUserInVoiceChannel(interaction);
    if (channel) {
      try {
        getOrCreateConnection(interaction.guild.id, channel);
        await interaction.reply("Poof! A wild *JukeJuke* has appeared! 🌟");
      } catch (error) {
        logError(error, 'join command');
        await interaction.reply({ content: "Failed to join voice channel.", ephemeral: true });
      }
    }
  }

  if (commandName === "leave") {
    const connection = connections.get(interaction.guild.id);
    if (connection) {
      connection.destroy();
      connections.delete(interaction.guild.id);
      musicPlaylist.delete(interaction.guild.id);
      await interaction.reply("*JukeJuke* left the voice channel.");
    } else {
      await interaction.reply({
        content: "*JukeJuke* is not in a voice channel.",
        ephemeral: true,
      });
    }
  }

  if (commandName === "play") {
    const song = interaction.options.getString("song");
    const channel = validateUserInVoiceChannel(interaction);
    
    if (!channel) return;
    if (!song?.trim()) {
      return await interaction.reply({ content: "Please provide a song to play.", ephemeral: true });
    }

    await interaction.deferReply();
    
    try {
      const connection = getOrCreateConnection(interaction.guild.id, channel);
      const guildId = interaction.guild.id;
      
      if (isPlayerActive(currentPlayer)) {
        const songInfo = await getSongInfo(song);
        if (!songInfo) {
          return await interaction.followUp("Could not find that song.");
        }
        
        if (!musicPlaylist.has(guildId)) {
          musicPlaylist.set(guildId, []);
        }
        musicPlaylist.get(guildId).push(songInfo);
        await interaction.followUp(
          `*JukeJuke* added **${songInfo.title}** to the playlist.`
        );
      } else {
        await playMusic(song, interaction, connection, true);
      }
    } catch (error) {
      logError(error, 'play command');
      await interaction.followUp("There was an error processing your request.");
    }
  }

  if (commandName === "pause") {
    if (currentPlayer && currentPlayer.state.status === AudioPlayerStatus.Playing) {
      currentPlayer.pause();
      await interaction.reply("*JukeJuke* paused the song.");
    } else {
      await interaction.reply({ content: "No song is currently playing.", ephemeral: true });
    }
  }

  if (commandName === "resume") {
    if (currentPlayer && currentPlayer.state.status === AudioPlayerStatus.Paused) {
      currentPlayer.unpause();
      await interaction.reply("*JukeJuke* resumed the song.");
    } else {
      await interaction.reply({ content: "The song is not paused.", ephemeral: true });
    }
  }

  if (commandName === "stop") {
    if (isPlayerActive(currentPlayer)) {
      const guildId = interaction.guild.id;
      musicPlaylist.delete(guildId);
      currentPlayer.stop();
      await interaction.reply("*JukeJuke* stopped the music and cleared the playlist.");
    } else {
      await interaction.reply({ content: "No song is currently playing.", ephemeral: true });
    }
  }

  if (commandName === "skip") {
    if (currentPlayer && currentPlayer.state.status === AudioPlayerStatus.Playing) {
      currentPlayer.stop();
      await interaction.reply("*JukeJuke* skipped to the next song.");
    } else {
      await interaction.reply({ content: "No song is currently playing.", ephemeral: true });
    }
  }

  if (commandName === "playlist") {
    const guildPlaylist = musicPlaylist.get(interaction.guild.id) || [];
    if (guildPlaylist.length > 0) {
      const playlistText = guildPlaylist
        .slice(0, 10)
        .map((track, index) => `${index + 1}. ${track.title}`)
        .join("\n");
      const remaining = guildPlaylist.length > 10 ? `\n...and ${guildPlaylist.length - 10} more` : '';
      await interaction.reply(`*JukeJuke's* current playlist:\n${playlistText}${remaining}`);
    } else {
      await interaction.reply({ content: "The playlist is currently empty.", ephemeral: true });
    }
  }
});

async function playMusic(song, interaction, connection, notify = false) {
  try {
    const songInfo = await getSongInfo(song);
    if (!songInfo) {
      await interaction.followUp("Could not find that song.");
      return;
    }

    const stream = await ytdl(songInfo.url, {
      filter: "audioonly",
      quality: "lowestaudio",
      highWaterMark: 1 << 25,
      dlChunkSize: 0,
      requestOptions: {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    });

    const resource = createAudioResource(stream, {
      inlineVolume: true,
      inputType: "arbitrary",
    });
    const player = createAudioPlayer();

    player.play(resource);
    connection.subscribe(player);
    currentPlayer = player;

    player.on(AudioPlayerStatus.Idle, () => {
      const guildId = interaction.guild.id;
      const guildPlaylist = musicPlaylist.get(guildId);
      if (guildPlaylist && guildPlaylist.length > 0) {
        const nextTrack = guildPlaylist.shift();
        playMusic(nextTrack.url, interaction, connection);
      }
    });

    player.on('error', (error) => {
      logError(error, 'audio player');
    });

    if (notify) {
      await interaction.followUp(`*JukeJuke* is now playing **${songInfo.title}**.`);
    }
  } catch (error) {
    logError(error, 'playMusic function');
    await interaction.followUp("There was an error playing the song.");
  }
}

async function getSongInfo(query) {
  try {
    if (!query || query.trim().length === 0) {
      return null;
    }
    
    const sanitizedQuery = query.trim().slice(0, 100);
    const searchResults = await ytSearch(sanitizedQuery);
    
    if (!searchResults || !searchResults.all || searchResults.all.length === 0) {
      return null;
    }
    
    const firstResult = searchResults.all.find(result => 
      result && result.url && result.title && result.type === 'video'
    );
    
    return firstResult ? { url: firstResult.url, title: firstResult.title } : null;
  } catch (error) {
    logError(error, 'getSongInfo function');
    return null;
  }
}

process.on('unhandledRejection', (error) => {
  logError(error, 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logError(error, 'uncaught exception');
  process.exit(1);
});

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN environment variable is required');
  process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN).catch((error) => {
  logError(error, 'bot login');
  process.exit(1);
});
