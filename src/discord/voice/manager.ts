import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import { ChannelType, type Client, ReadyListener } from "@buape/carbon";
import type { VoicePlugin } from "@buape/carbon/voice";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { agentCommand } from "../../commands/agent.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig, TtsConfig } from "../../config/types.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "../../media-understanding/runner.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { RuntimeEnv } from "../../runtime.js";
import { parseTtsDirectives } from "../../tts/tts-core.js";
import { resolveTtsConfig, textToSpeech, type ResolvedTtsConfig } from "../../tts/tts.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MIN_SEGMENT_SECONDS = 0.35;
const SILENCE_DURATION_MS = 1_000;
const PLAYBACK_READY_TIMEOUT_MS = 15_000;
const SPEAKING_READY_TIMEOUT_MS = 60_000;

const logger = createSubsystemLogger("discord/voice");

const logVoiceVerbose = (message: string) => {
  logVerbose(`discord voice: ${message}`);
};

type VoiceOperationResult = {
  ok: boolean;
  message: string;
  channelId?: string;
  guildId?: string;
};

type VoiceSessionEntry = {
  guildId: string;
  channelId: string;
  sessionChannelId: string;
  route: ReturnType<typeof resolveAgentRoute>;
  connection: VoiceConnection;
  player: AudioPlayer;
  playbackQueue: Promise<void>;
  processingQueue: Promise<void>;
  activeSpeakers: Set<string>;
  stop: () => void;
};

function mergeTtsConfig(base: TtsConfig, override?: TtsConfig): TtsConfig {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    modelOverrides: {
      ...base.modelOverrides,
      ...override.modelOverrides,
    },
    elevenlabs: {
      ...base.elevenlabs,
      ...override.elevenlabs,
      voiceSettings: {
        ...base.elevenlabs?.voiceSettings,
        ...override.elevenlabs?.voiceSettings,
      },
    },
    openai: {
      ...base.openai,
      ...override.openai,
    },
    edge: {
      ...base.edge,
      ...override.edge,
    },
  };
}

function resolveVoiceTtsConfig(params: { cfg: OpenClawConfig; override?: TtsConfig }): {
  cfg: OpenClawConfig;
  resolved: ResolvedTtsConfig;
} {
  if (!params.override) {
    return { cfg: params.cfg, resolved: resolveTtsConfig(params.cfg) };
  }
  const base = params.cfg.messages?.tts ?? {};
  const merged = mergeTtsConfig(base, params.override);
  const messages = params.cfg.messages ?? {};
  const cfg = {
    ...params.cfg,
    messages: {
      ...messages,
      tts: merged,
    },
  };
  return { cfg, resolved: resolveTtsConfig(cfg) };
}

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type OpusDecoder = {
  decode: (buffer: Buffer) => Buffer;
};

function createOpusDecoder(): { decoder: OpusDecoder; name: string } | null {
  try {
    const OpusScript = require("opusscript") as {
      new (sampleRate: number, channels: number, application: number): OpusDecoder;
      Application: { AUDIO: number };
    };
    const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    return { decoder, name: "opusscript" };
  } catch (err) {
    logger.warn(`discord voice: opusscript init failed: ${formatErrorMessage(err)}`);
  }
  try {
    const { OpusEncoder } = require("@discordjs/opus") as {
      OpusEncoder: new (sampleRate: number, channels: number) => OpusDecoder;
    };
    const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    return { decoder, name: "@discordjs/opus" };
  } catch (err) {
    logger.warn(`discord voice: opus decoder init failed: ${formatErrorMessage(err)}`);
  }
  return null;
}

async function decodeOpusStream(stream: Readable): Promise<Buffer> {
  const selected = createOpusDecoder();
  if (!selected) {
    return Buffer.alloc(0);
  }
  logVoiceVerbose(`opus decoder: ${selected.name}`);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function estimateDurationSeconds(pcm: Buffer): number {
  const bytesPerSample = (BIT_DEPTH / 8) * CHANNELS;
  if (bytesPerSample <= 0) {
    return 0;
  }
  return pcm.length / (bytesPerSample * SAMPLE_RATE);
}

async function writeWavFile(pcm: Buffer): Promise<{ path: string; durationSeconds: number }> {
  const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "discord-voice-"));
  const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);
  const wav = buildWavBuffer(pcm);
  await fs.writeFile(filePath, wav);
  scheduleTempCleanup(tempDir);
  return { path: filePath, durationSeconds: estimateDurationSeconds(pcm) };
}

function scheduleTempCleanup(tempDir: string, delayMs: number = 30 * 60 * 1000): void {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
      if (shouldLogVerbose()) {
        logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);
      }
    });
  }, delayMs);
  timer.unref();
}

async function transcribeAudio(params: {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
}): Promise<string | undefined> {
  const ctx: MsgContext = {
    MediaPath: params.filePath,
    MediaType: "audio/wav",
  };
  const attachments = normalizeMediaAttachments(ctx);
  if (attachments.length === 0) {
    return undefined;
  }
  const cache = createMediaAttachmentCache(attachments);
  const providerRegistry = buildProviderRegistry();
  try {
    const result = await runCapability({
      capability: "audio",
      cfg: params.cfg,
      ctx,
      attachments: cache,
      media: attachments,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      providerRegistry,
      config: params.cfg.tools?.media?.audio,
    });
    const output = result.outputs.find((entry) => entry.kind === "audio.transcription");
    const text = output?.text?.trim();
    return text || undefined;
  } finally {
    await cache.cleanup();
  }
}

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private botUserId?: string;
  private readonly voiceEnabled: boolean;
  private autoJoinTask: Promise<void> | null = null;

  constructor(
    private params: {
      client: Client;
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
    },
  ) {
    this.botUserId = params.botUserId;
    this.voiceEnabled = params.discordConfig.voice?.enabled !== false;
  }

  setBotUserId(id?: string) {
    if (id) {
      this.botUserId = id;
    }
  }

  isEnabled() {
    return this.voiceEnabled;
  }

  async autoJoin(): Promise<void> {
    if (!this.voiceEnabled) {
      return;
    }
    if (this.autoJoinTask) {
      return this.autoJoinTask;
    }
    this.autoJoinTask = (async () => {
      const entries = this.params.discordConfig.voice?.autoJoin ?? [];
      logVoiceVerbose(`autoJoin: ${entries.length} entries`);
      const seenGuilds = new Set<string>();
      for (const entry of entries) {
        const guildId = entry.guildId.trim();
        if (!guildId) {
          continue;
        }
        if (seenGuilds.has(guildId)) {
          logger.warn(
            `discord voice: autoJoin has multiple entries for guild ${guildId}; skipping`,
          );
          continue;
        }
        seenGuilds.add(guildId);
        logVoiceVerbose(`autoJoin: joining guild ${guildId} channel ${entry.channelId}`);
        await this.join({
          guildId: entry.guildId,
          channelId: entry.channelId,
        });
      }
    })().finally(() => {
      this.autoJoinTask = null;
    });
    return this.autoJoinTask;
  }

  status(): VoiceOperationResult[] {
    return Array.from(this.sessions.values()).map((session) => ({
      ok: true,
      message: `connected: guild ${session.guildId} channel ${session.channelId}`,
      guildId: session.guildId,
      channelId: session.channelId,
    }));
  }

  async join(params: { guildId: string; channelId: string }): Promise<VoiceOperationResult> {
    if (!this.voiceEnabled) {
      return {
        ok: false,
        message: "Discord voice is disabled (channels.discord.voice.enabled).",
      };
    }
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    if (!guildId || !channelId) {
      return { ok: false, message: "Missing guildId or channelId." };
    }
    logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);

    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
      logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
      return { ok: true, message: `Already connected to <#${channelId}>.`, guildId, channelId };
    }
    if (existing) {
      logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
      await this.leave({ guildId });
    }

    const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
    if (!channelInfo || ("type" in channelInfo && !isVoiceChannel(channelInfo.type))) {
      return { ok: false, message: `Channel ${channelId} is not a voice channel.` };
    }
    const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : undefined;
    if (channelGuildId && channelGuildId !== guildId) {
      return { ok: false, message: "Voice channel is not in this guild." };
    }

    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    if (!voicePlugin) {
      return { ok: false, message: "Discord voice plugin is not available." };
    }

    const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, PLAYBACK_READY_TIMEOUT_MS);
      logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
    } catch (err) {
      connection.destroy();
      return { ok: false, message: `Failed to join voice channel: ${formatErrorMessage(err)}` };
    }

    const sessionChannelId = channelInfo?.id ?? channelId;
    // Use the voice channel id as the session channel so text chat in the voice channel
    // shares the same session as spoken audio.
    if (sessionChannelId !== channelId) {
      logVoiceVerbose(
        `join: using session channel ${sessionChannelId} for voice channel ${channelId}`,
      );
    }
    const route = resolveAgentRoute({
      cfg: this.params.cfg,
      channel: "discord",
      accountId: this.params.accountId,
      guildId,
      peer: { kind: "channel", id: sessionChannelId },
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const entry: VoiceSessionEntry = {
      guildId,
      channelId,
      sessionChannelId,
      route,
      connection,
      player,
      playbackQueue: Promise.resolve(),
      processingQueue: Promise.resolve(),
      activeSpeakers: new Set(),
      stop: () => {
        player.stop();
        connection.destroy();
      },
    };

    const speakingHandler = (userId: string) => {
      void this.handleSpeakingStart(entry, userId).catch((err) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
      });
    };

    connection.receiver.speaking.on("start", speakingHandler);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.sessions.delete(guildId);
        connection.destroy();
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.sessions.delete(guildId);
    });

    player.on("error", (err) => {
      logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
    });

    this.sessions.set(guildId, entry);
    return {
      ok: true,
      message: `Joined <#${channelId}>.`,
      guildId,
      channelId,
    };
  }

  async leave(params: { guildId: string; channelId?: string }): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.sessions.get(guildId);
    if (!entry) {
      return { ok: false, message: "Not connected to a voice channel." };
    }
    if (params.channelId && params.channelId !== entry.channelId) {
      return { ok: false, message: "Not connected to that voice channel." };
    }
    entry.stop();
    this.sessions.delete(guildId);
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      ok: true,
      message: `Left <#${entry.channelId}>.`,
      guildId,
      channelId: entry.channelId,
    };
  }

  async destroy(): Promise<void> {
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    this.sessions.clear();
  }

  private enqueueProcessing(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.processingQueue = entry.processingQueue
      .then(task)
      .catch((err) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`));
  }

  private enqueuePlayback(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.playbackQueue = entry.playbackQueue
      .then(task)
      .catch((err) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`));
  }

  private async handleSpeakingStart(entry: VoiceSessionEntry, userId: string) {
    if (!userId || entry.activeSpeakers.has(userId)) {
      return;
    }
    if (this.botUserId && userId === this.botUserId) {
      return;
    }

    entry.activeSpeakers.add(userId);
    logVoiceVerbose(
      `capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    if (entry.player.state.status === AudioPlayerStatus.Playing) {
      entry.player.stop(true);
    }

    const stream = entry.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SILENCE_DURATION_MS,
      },
    });
    stream.on("error", (err) => {
      logger.warn(`discord voice: receive error: ${formatErrorMessage(err)}`);
    });

    try {
      const pcm = await decodeOpusStream(stream);
      if (pcm.length === 0) {
        logVoiceVerbose(
          `capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      const { path: wavPath, durationSeconds } = await writeWavFile(pcm);
      if (durationSeconds < MIN_SEGMENT_SECONDS) {
        logVoiceVerbose(
          `capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      logVoiceVerbose(
        `capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      this.enqueueProcessing(entry, async () => {
        await this.processSegment({ entry, wavPath, userId, durationSeconds });
      });
    } finally {
      entry.activeSpeakers.delete(userId);
    }
  }

  private async processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
  }) {
    const { entry, wavPath, userId, durationSeconds } = params;
    logVoiceVerbose(
      `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const transcript = await transcribeAudio({
      cfg: this.params.cfg,
      agentId: entry.route.agentId,
      filePath: wavPath,
    });
    if (!transcript) {
      logVoiceVerbose(
        `transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    logVoiceVerbose(
      `transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
    );

    const speakerLabel = await this.resolveSpeakerLabel(entry.guildId, userId);
    const prompt = speakerLabel ? `${speakerLabel}: ${transcript}` : transcript;

    const result = await agentCommand(
      {
        message: prompt,
        sessionKey: entry.route.sessionKey,
        agentId: entry.route.agentId,
        messageChannel: "discord",
        deliver: false,
      },
      this.params.runtime,
    );

    const replyText = (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n")
      .trim();

    if (!replyText) {
      logVoiceVerbose(
        `reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    logVoiceVerbose(
      `reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
    );

    const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
      cfg: this.params.cfg,
      override: this.params.discordConfig.voice?.tts,
    });
    const directive = parseTtsDirectives(replyText, ttsConfig.modelOverrides);
    const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
    if (!speakText) {
      logVoiceVerbose(
        `tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }

    const ttsResult = await textToSpeech({
      text: speakText,
      cfg: ttsCfg,
      channel: "discord",
      overrides: directive.overrides,
    });
    if (!ttsResult.success || !ttsResult.audioPath) {
      logger.warn(`discord voice: TTS failed: ${ttsResult.error ?? "unknown error"}`);
      return;
    }
    const audioPath = ttsResult.audioPath;
    logVoiceVerbose(
      `tts ok (${speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
    );

    this.enqueuePlayback(entry, async () => {
      logVoiceVerbose(
        `playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(audioPath)}`,
      );
      const resource = createAudioResource(audioPath);
      entry.player.play(resource);
      await entersState(entry.player, AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS).catch(
        () => undefined,
      );
      await entersState(entry.player, AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS).catch(
        () => undefined,
      );
      logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
    });
  }

  private async resolveSpeakerLabel(guildId: string, userId: string): Promise<string | undefined> {
    try {
      const member = await this.params.client.fetchMember(guildId, userId);
      return member.nickname ?? member.user?.globalName ?? member.user?.username ?? userId;
    } catch {
      try {
        const user = await this.params.client.fetchUser(userId);
        return user.globalName ?? user.username ?? userId;
      } catch {
        return userId;
      }
    }
  }
}

export class DiscordVoiceReadyListener extends ReadyListener {
  constructor(private manager: DiscordVoiceManager) {
    super();
  }

  async handle() {
    await this.manager.autoJoin();
  }
}

function isVoiceChannel(type: ChannelType) {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
