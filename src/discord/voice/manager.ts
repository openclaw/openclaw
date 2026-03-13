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
  NetworkingStatusCode,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
  type VoiceConnectionState,
} from "@discordjs/voice";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isDangerousNameMatchingEnabled } from "../../config/dangerous-name-matching.js";
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
import { formatMention } from "../mentions.js";
import { resolveDiscordOwnerAccess } from "../monitor/allow-list.js";
import { formatDiscordUserTag } from "../monitor/format.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import { sanitizeVoiceReplyTextForSpeech } from "./sanitize.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MIN_SEGMENT_SECONDS = 0.35;
const CAPTURE_FINALIZE_GRACE_MS = 1_200;
const PLAYBACK_READY_TIMEOUT_MS = 30_000;
const SPEAKING_READY_TIMEOUT_MS = 60_000;
const VOICE_JOIN_MAX_ATTEMPTS = 2;
const VOICE_JOIN_RETRY_DELAY_MS = 1_500;
const DECRYPT_FAILURE_WINDOW_MS = 30_000;
const DECRYPT_FAILURE_RECONNECT_THRESHOLD = 3;
const DECRYPT_FAILURE_PATTERN = /DecryptionFailed\(/;
const DAVE_PASSTHROUGH_DISABLED_PATTERN = /UnencryptedWhenPassthroughDisabled/;
const DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS = 30;
const DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS = 15;
const SPEAKER_CONTEXT_CACHE_TTL_MS = 60_000;

const logger = createSubsystemLogger("discord/voice");

const logVoiceVerbose = (message: string) => {
  logVerbose(`discord voice: ${message}`);
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? stringifyUnknown((err as { name?: unknown }).name) : "";
  const message =
    "message" in err
      ? stringifyUnknown((err as { message?: unknown }).message)
      : stringifyUnknown(err);
  return (
    name === "AbortError" ||
    message.includes("The operation was aborted") ||
    message.includes("aborted")
  );
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function summarizeError(err: unknown): string {
  if (!err) {
    return "<empty error>";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err !== "object") {
    return stringifyUnknown(err);
  }
  const e = err as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const bits = [
    `name=${stringifyUnknown(e.name)}`,
    `message=${stringifyUnknown(e.message)}`,
    `code=${stringifyUnknown(e.code)}`,
    `cause=${stringifyUnknown(e.cause)}`,
  ];
  return bits.join(" ");
}

function statusName(status: VoiceConnectionStatus | AudioPlayerStatus): string {
  return String(status);
}

function logVoiceConnectionState(guildId: string, channelId: string, state: VoiceConnectionState) {
  logger.info(
    `discord voice: state guild=${guildId} channel=${channelId} status=${statusName(state.status)}`,
  );
}

function sanitizeVoiceLogValue(value: unknown): string {
  return stringifyUnknown(value).replace(/\s+/g, " ").trim();
}

function summarizeVoiceGatewayPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return sanitizeVoiceLogValue(payload);
  }
  const record = payload as { op?: unknown; d?: unknown };
  const parts = [`op=${sanitizeVoiceLogValue(record.op ?? "")}`];
  if (record.d && typeof record.d === "object") {
    const data = record.d as Record<string, unknown>;
    for (const key of [
      "guild_id",
      "channel_id",
      "user_id",
      "session_id",
      "self_deaf",
      "self_mute",
      "endpoint",
    ]) {
      if (key in data) {
        parts.push(`${key}=${sanitizeVoiceLogValue(data[key])}`);
      }
    }
    if ("token" in data) {
      const token = data.token;
      parts.push(
        typeof token === "string" ? `token=redacted(len=${token.length})` : "token=present",
      );
    }
  }
  return parts.join(" ");
}

function summarizeVoiceGatewayUpdate(update: unknown, keys: readonly string[]): string {
  if (!update || typeof update !== "object") {
    return sanitizeVoiceLogValue(update);
  }
  const data = update as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of keys) {
    if (key in data) {
      parts.push(`${key}=${sanitizeVoiceLogValue(data[key])}`);
    }
  }
  if ("token" in data) {
    const token = data.token;
    parts.push(typeof token === "string" ? `token=redacted(len=${token.length})` : "token=present");
  }
  return parts.join(" ");
}

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
  activeCaptureStreams: Map<string, Readable>;
  captureFinalizeTimers: Map<string, ReturnType<typeof setTimeout>>;
  decryptFailureCount: number;
  lastDecryptFailureAt: number;
  decryptRecoveryInFlight: boolean;
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

type OpusDecoderFactory = {
  load: () => OpusDecoder;
  name: string;
};

let warnedOpusMissing = false;
let cachedOpusDecoderFactory: OpusDecoderFactory | null | "unresolved" = "unresolved";

function resolveOpusDecoderFactory(): OpusDecoderFactory | null {
  const factories: OpusDecoderFactory[] = [
    {
      name: "@discordjs/opus",
      load: () => {
        const DiscordOpus = require("@discordjs/opus") as {
          OpusEncoder: new (
            sampleRate: number,
            channels: number,
          ) => {
            decode: (buffer: Buffer) => Buffer;
          };
        };
        return new DiscordOpus.OpusEncoder(SAMPLE_RATE, CHANNELS);
      },
    },
    {
      name: "opusscript",
      load: () => {
        const OpusScript = require("opusscript") as {
          new (sampleRate: number, channels: number, application: number): OpusDecoder;
          Application: { AUDIO: number };
        };
        return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
      },
    },
  ];

  const failures: string[] = [];
  for (const factory of factories) {
    try {
      factory.load();
      return factory;
    } catch (err) {
      failures.push(`${factory.name}: ${formatErrorMessage(err)}`);
    }
  }

  if (!warnedOpusMissing) {
    warnedOpusMissing = true;
    logger.warn(
      `discord voice: no usable opus decoder available (${failures.join("; ")}); cannot decode voice audio`,
    );
  }
  return null;
}

function createOpusDecoder(): { decoder: OpusDecoder; name: string } | null {
  const factory = getOrCreateOpusDecoderFactory();
  if (!factory) {
    return null;
  }
  return { decoder: factory.load(), name: factory.name };
}

function getOrCreateOpusDecoderFactory(): OpusDecoderFactory | null {
  if (cachedOpusDecoderFactory !== "unresolved") {
    return cachedOpusDecoderFactory;
  }
  cachedOpusDecoderFactory = resolveOpusDecoderFactory();
  return cachedOpusDecoderFactory;
}

async function decodeOpusStream(stream: Readable): Promise<{
  pcm: Buffer;
  opusChunkCount: number;
  opusBytes: number;
  pcmChunkCount: number;
  pcmBytes: number;
}> {
  const selected = createOpusDecoder();
  if (!selected) {
    return {
      pcm: Buffer.alloc(0),
      opusChunkCount: 0,
      opusBytes: 0,
      pcmChunkCount: 0,
      pcmBytes: 0,
    };
  }
  logVoiceVerbose(`opus decoder: ${selected.name}`);
  const chunks: Buffer[] = [];
  let opusChunkCount = 0;
  let opusBytes = 0;
  let pcmChunkCount = 0;
  let pcmBytes = 0;
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      opusChunkCount += 1;
      opusBytes += chunk.length;
      const decoded = selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        const decodedBuffer = Buffer.from(decoded);
        pcmChunkCount += 1;
        pcmBytes += decodedBuffer.length;
        chunks.push(decodedBuffer);
      }
    }
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  }
  return {
    pcm: chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0),
    opusChunkCount,
    opusBytes,
    pcmChunkCount,
    pcmBytes,
  };
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
  private readonly ownerAllowFrom: string[];
  private readonly allowDangerousNameMatching: boolean;
  private readonly speakerContextCache = new Map<
    string,
    {
      label: string;
      senderIsOwner: boolean;
      expiresAt: number;
    }
  >();

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
    this.ownerAllowFrom =
      params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [];
    this.allowDangerousNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
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
      return {
        ok: true,
        message: `Already connected to ${formatMention({ channelId })}.`,
        guildId,
        channelId,
      };
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

    const rawAdapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
    const daveEncryption = this.params.discordConfig.voice?.daveEncryption;
    const decryptionFailureTolerance = this.params.discordConfig.voice?.decryptionFailureTolerance;
    logVoiceVerbose(
      `join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${
        decryptionFailureTolerance ?? "default"
      }`,
    );
    let connection: VoiceConnection | null = null;
    let lastJoinError: unknown;
    for (let attempt = 1; attempt <= VOICE_JOIN_MAX_ATTEMPTS; attempt++) {
      const attemptStartedAt = Date.now();
      let adapterCreateCount = 0;
      let voiceStateUpdateCount = 0;
      let voiceServerUpdateCount = 0;
      let lastVoiceStateSummary = "none";
      let lastVoiceServerSummary = "none";
      let lastVoiceStateAtMs: number | null = null;
      let lastVoiceServerAtMs: number | null = null;
      const adapterCreator = ((methods: Parameters<typeof rawAdapterCreator>[0]) => {
        adapterCreateCount += 1;
        logger.info(
          `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} adapter-create guild=${guildId} channel=${channelId} count=${adapterCreateCount} t+${Date.now() - attemptStartedAt}ms`,
        );
        const wrappedMethods = {
          ...methods,
          onVoiceStateUpdate: (update: Parameters<typeof methods.onVoiceStateUpdate>[0]) => {
            voiceStateUpdateCount += 1;
            lastVoiceStateAtMs = Date.now();
            lastVoiceStateSummary = summarizeVoiceGatewayUpdate(update, [
              "guild_id",
              "channel_id",
              "user_id",
              "session_id",
              "deaf",
              "mute",
              "self_deaf",
              "self_mute",
              "suppress",
            ]);
            logger.info(
              `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} gateway-in VOICE_STATE_UPDATE guild=${guildId} channel=${channelId} count=${voiceStateUpdateCount} t+${lastVoiceStateAtMs - attemptStartedAt}ms ${lastVoiceStateSummary}`,
            );
            return methods.onVoiceStateUpdate(update);
          },
          onVoiceServerUpdate: (update: Parameters<typeof methods.onVoiceServerUpdate>[0]) => {
            voiceServerUpdateCount += 1;
            lastVoiceServerAtMs = Date.now();
            lastVoiceServerSummary = summarizeVoiceGatewayUpdate(update, ["guild_id", "endpoint"]);
            logger.info(
              `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} gateway-in VOICE_SERVER_UPDATE guild=${guildId} channel=${channelId} count=${voiceServerUpdateCount} t+${lastVoiceServerAtMs - attemptStartedAt}ms ${lastVoiceServerSummary}`,
            );
            return methods.onVoiceServerUpdate(update);
          },
          destroy: () => {
            logger.info(
              `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} adapter-methods-destroy guild=${guildId} channel=${channelId} t+${Date.now() - attemptStartedAt}ms`,
            );
            return methods.destroy();
          },
        };
        const adapter = rawAdapterCreator(wrappedMethods);
        return {
          sendPayload: (payload: Parameters<typeof adapter.sendPayload>[0]) => {
            const accepted = adapter.sendPayload(payload);
            logger.info(
              `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} gateway-out guild=${guildId} channel=${channelId} accepted=${accepted} t+${Date.now() - attemptStartedAt}ms ${summarizeVoiceGatewayPayload(payload)}`,
            );
            return accepted;
          },
          destroy: () => {
            logger.info(
              `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} adapter-destroy guild=${guildId} channel=${channelId} t+${Date.now() - attemptStartedAt}ms`,
            );
            adapter.destroy();
          },
        };
      }) as typeof rawAdapterCreator;

      connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator,
        selfDeaf: false,
        selfMute: false,
        debug: true,
        daveEncryption,
        decryptionFailureTolerance,
      });

      const stateChangeHandler = (
        _oldState: VoiceConnectionState,
        newState: VoiceConnectionState,
      ) => {
        logVoiceConnectionState(guildId, channelId, newState);
      };
      const debugHandler = (message: string) => {
        logger.info(
          `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} library-debug guild=${guildId} channel=${channelId} t+${Date.now() - attemptStartedAt}ms ${sanitizeVoiceLogValue(message)}`,
        );
      };
      connection.on("stateChange", stateChangeHandler);
      connection.on("debug", debugHandler);

      try {
        logger.info(
          `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} started guild=${guildId} channel=${channelId}`,
        );
        await entersState(connection, VoiceConnectionStatus.Ready, PLAYBACK_READY_TIMEOUT_MS);
        logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
        logger.info(
          `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} ready guild=${guildId} channel=${channelId} adapterCreates=${adapterCreateCount} voiceStateUpdates=${voiceStateUpdateCount} voiceServerUpdates=${voiceServerUpdateCount}`,
        );
        connection.off("stateChange", stateChangeHandler);
        connection.off("debug", debugHandler);
        break;
      } catch (err) {
        lastJoinError = err;
        const retryable = isAbortLikeError(err) && attempt < VOICE_JOIN_MAX_ATTEMPTS;
        const voiceStateLag =
          lastVoiceStateAtMs === null ? "never" : `${lastVoiceStateAtMs - attemptStartedAt}ms`;
        const voiceServerLag =
          lastVoiceServerAtMs === null ? "never" : `${lastVoiceServerAtMs - attemptStartedAt}ms`;
        logger.warn(
          `discord voice: join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} failed guild=${guildId} channel=${channelId} retryable=${retryable} adapterCreates=${adapterCreateCount} voiceStateUpdates=${voiceStateUpdateCount}@${voiceStateLag} voiceServerUpdates=${voiceServerUpdateCount}@${voiceServerLag} lastVoiceState="${lastVoiceStateSummary}" lastVoiceServer="${lastVoiceServerSummary}" ${summarizeError(err)}`,
        );
        connection.off("stateChange", stateChangeHandler);
        connection.off("debug", debugHandler);
        connection.destroy();
        if (!retryable) {
          connection = null;
          break;
        }
        await sleep(VOICE_JOIN_RETRY_DELAY_MS);
      }
    }

    if (!connection) {
      return {
        ok: false,
        message: `Failed to join voice channel: ${formatErrorMessage(lastJoinError)} (after ${VOICE_JOIN_MAX_ATTEMPTS} attempts)`,
      };
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

    let speakingHandler: ((userId: string) => void) | undefined;
    let speakingEndHandler: ((userId: string) => void) | undefined;
    let disconnectedHandler: (() => Promise<void>) | undefined;
    let destroyedHandler: (() => void) | undefined;
    let playerErrorHandler: ((err: Error) => void) | undefined;
    const clearSessionIfCurrent = () => {
      const active = this.sessions.get(guildId);
      if (active?.connection === connection) {
        this.sessions.delete(guildId);
      }
    };

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
      activeCaptureStreams: new Map(),
      captureFinalizeTimers: new Map(),
      decryptFailureCount: 0,
      lastDecryptFailureAt: 0,
      decryptRecoveryInFlight: false,
      stop: () => {
        if (speakingHandler) {
          connection.receiver.speaking.off("start", speakingHandler);
        }
        if (speakingEndHandler) {
          connection.receiver.speaking.off("end", speakingEndHandler);
        }
        for (const timer of entry.captureFinalizeTimers.values()) {
          clearTimeout(timer);
        }
        entry.captureFinalizeTimers.clear();
        for (const stream of entry.activeCaptureStreams.values()) {
          stream.destroy();
        }
        entry.activeCaptureStreams.clear();
        if (disconnectedHandler) {
          connection.off(VoiceConnectionStatus.Disconnected, disconnectedHandler);
        }
        if (destroyedHandler) {
          connection.off(VoiceConnectionStatus.Destroyed, destroyedHandler);
        }
        if (playerErrorHandler) {
          player.off("error", playerErrorHandler);
        }
        player.stop();
        connection.destroy();
      },
    };

    this.enableDaveReceivePassthrough(
      entry,
      "post-join warmup",
      DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
    );

    speakingHandler = (userId: string) => {
      void this.handleSpeakingStart(entry, userId).catch((err) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
      });
    };
    speakingEndHandler = (userId: string) => {
      this.scheduleCaptureFinalize(entry, userId, "speaker end");
    };

    disconnectedHandler = async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        clearSessionIfCurrent();
        connection.destroy();
      }
    };
    destroyedHandler = () => {
      clearSessionIfCurrent();
    };
    playerErrorHandler = (err: Error) => {
      logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
    };

    connection.receiver.speaking.on("start", speakingHandler);
    connection.receiver.speaking.on("end", speakingEndHandler);
    connection.on(VoiceConnectionStatus.Disconnected, disconnectedHandler);
    connection.on(VoiceConnectionStatus.Destroyed, destroyedHandler);
    player.on("error", playerErrorHandler);

    this.sessions.set(guildId, entry);
    return {
      ok: true,
      message: `Joined ${formatMention({ channelId })}.`,
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
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
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

  private clearCaptureFinalizeTimer(entry: VoiceSessionEntry, userId: string) {
    const timer = entry.captureFinalizeTimers.get(userId);
    if (!timer) {
      return false;
    }
    clearTimeout(timer);
    entry.captureFinalizeTimers.delete(userId);
    return true;
  }

  private scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string) {
    const stream = entry.activeCaptureStreams.get(userId);
    if (!stream) {
      return;
    }
    this.clearCaptureFinalizeTimer(entry, userId);
    const timer = setTimeout(() => {
      entry.captureFinalizeTimers.delete(userId);
      const activeStream = entry.activeCaptureStreams.get(userId);
      if (!activeStream) {
        return;
      }
      logVoiceVerbose(
        `capture finalize: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${CAPTURE_FINALIZE_GRACE_MS}ms`,
      );
      activeStream.destroy();
    }, CAPTURE_FINALIZE_GRACE_MS);
    entry.captureFinalizeTimers.set(userId, timer);
    logVoiceVerbose(
      `capture finalize scheduled: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${CAPTURE_FINALIZE_GRACE_MS}ms`,
    );
  }

  private async handleSpeakingStart(entry: VoiceSessionEntry, userId: string) {
    if (!userId) {
      return;
    }
    if (entry.activeSpeakers.has(userId)) {
      const extended = this.clearCaptureFinalizeTimer(entry, userId);
      logVoiceVerbose(
        `capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`,
      );
      return;
    }
    if (this.botUserId && userId === this.botUserId) {
      logVoiceVerbose(
        `capture start ignored (bot user): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }

    this.enableDaveReceivePassthrough(
      entry,
      `speaker ${userId} start`,
      DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
    );

    entry.activeSpeakers.add(userId);
    logVoiceVerbose(
      `capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    if (entry.player.state.status === AudioPlayerStatus.Playing) {
      entry.player.stop(true);
    }

    const stream = entry.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });
    entry.activeCaptureStreams.set(userId, stream);
    this.clearCaptureFinalizeTimer(entry, userId);
    logVoiceVerbose(
      `receiver subscribe: guild ${entry.guildId} channel ${entry.channelId} user ${userId} end=Manual finalizeGrace=${CAPTURE_FINALIZE_GRACE_MS}ms`,
    );
    let streamAborted = false;
    stream.on("end", () => {
      logVoiceVerbose(
        `receiver stream end: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
    });
    stream.on("close", () => {
      logVoiceVerbose(
        `receiver stream close: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
    });
    stream.on("error", (err) => {
      streamAborted = isAbortLikeError(err);
      logger.warn(
        `discord voice: receiver stream error guild=${entry.guildId} channel=${entry.channelId} user=${userId}: ${formatErrorMessage(err)}`,
      );
      this.handleReceiveError(entry, err);
    });

    try {
      const decoded = await decodeOpusStream(stream);
      logVoiceVerbose(
        `decode stats: guild ${entry.guildId} channel ${entry.channelId} user ${userId} opusChunks=${decoded.opusChunkCount} opusBytes=${decoded.opusBytes} pcmChunks=${decoded.pcmChunkCount} pcmBytes=${decoded.pcmBytes}`,
      );
      if (decoded.pcm.length === 0) {
        logVoiceVerbose(
          `capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      this.resetDecryptFailureState(entry);
      logVoiceVerbose(
        `wav write start: guild ${entry.guildId} channel ${entry.channelId} user ${userId} pcmBytes=${decoded.pcm.length}`,
      );
      const { path: wavPath, durationSeconds } = await writeWavFile(decoded.pcm);
      logVoiceVerbose(
        `wav write done: guild ${entry.guildId} channel ${entry.channelId} user ${userId} path=${wavPath} duration=${durationSeconds.toFixed(2)}s aborted=${streamAborted}`,
      );
      const minimumDurationSeconds = streamAborted
        ? Math.min(MIN_SEGMENT_SECONDS, 0.2)
        : MIN_SEGMENT_SECONDS;
      if (durationSeconds < minimumDurationSeconds) {
        logVoiceVerbose(
          `capture too short (${durationSeconds.toFixed(2)}s < ${minimumDurationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId} aborted=${streamAborted}`,
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
      this.clearCaptureFinalizeTimer(entry, userId);
      entry.activeCaptureStreams.delete(userId);
      entry.activeSpeakers.delete(userId);
      logVoiceVerbose(
        `capture end: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
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
      `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId} wav=${wavPath}`,
    );
    logVoiceVerbose(
      `transcription start: guild ${entry.guildId} channel ${entry.channelId} user ${userId} file=${wavPath}`,
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

    const speaker = await this.resolveSpeakerContext(entry.guildId, userId);
    const prompt = formatVoiceIngressPrompt(transcript, speaker.label);

    const result = await agentCommandFromIngress(
      {
        message: prompt,
        sessionKey: entry.route.sessionKey,
        agentId: entry.route.agentId,
        messageChannel: "discord",
        senderIsOwner: speaker.senderIsOwner,
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
    const directive = parseTtsDirectives(
      replyText,
      ttsConfig.modelOverrides,
      ttsConfig.openai.baseUrl,
    );
    const rawSpeakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
    const speakText = sanitizeVoiceReplyTextForSpeech(rawSpeakText, speaker.label);
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

  private handleReceiveError(entry: VoiceSessionEntry, err: unknown) {
    const message = formatErrorMessage(err);
    logger.warn(`discord voice: receive error: ${message}`);
    if (DAVE_PASSTHROUGH_DISABLED_PATTERN.test(message)) {
      const rearmed = this.enableDaveReceivePassthrough(
        entry,
        "receive decrypt error",
        DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
      );
      if (rearmed) {
        logger.warn(
          "discord voice: re-armed DAVE passthrough window after transition-time unencrypted packet",
        );
        return;
      }
    }
    if (!DECRYPT_FAILURE_PATTERN.test(message)) {
      return;
    }
    const now = Date.now();
    if (now - entry.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) {
      entry.decryptFailureCount = 0;
    }
    entry.lastDecryptFailureAt = now;
    entry.decryptFailureCount += 1;
    if (entry.decryptFailureCount === 1) {
      logger.warn(
        "discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)",
      );
    }
    if (
      entry.decryptFailureCount < DECRYPT_FAILURE_RECONNECT_THRESHOLD ||
      entry.decryptRecoveryInFlight
    ) {
      return;
    }
    entry.decryptRecoveryInFlight = true;
    this.resetDecryptFailureState(entry);
    void this.recoverFromDecryptFailures(entry)
      .catch((recoverErr) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`),
      )
      .finally(() => {
        entry.decryptRecoveryInFlight = false;
      });
  }

  private enableDaveReceivePassthrough(
    entry: Pick<VoiceSessionEntry, "guildId" | "channelId" | "connection">,
    reason: string,
    expirySeconds: number,
  ): boolean {
    const state = entry.connection.state;
    if (state.status !== VoiceConnectionStatus.Ready) {
      return false;
    }
    const networkingState = state.networking.state;
    if (
      networkingState.code !== NetworkingStatusCode.Ready &&
      networkingState.code !== NetworkingStatusCode.Resuming
    ) {
      return false;
    }
    const daveSession = networkingState.dave?.session;
    if (!daveSession) {
      return false;
    }
    try {
      daveSession.setPassthroughMode(true, expirySeconds);
      logger.info(
        `discord voice: enabled DAVE receive passthrough guild=${entry.guildId} channel=${entry.channelId} expiry=${expirySeconds}s reason=${reason}`,
      );
      return true;
    } catch (passthroughErr) {
      logger.warn(
        `discord voice: failed to enable DAVE passthrough guild=${entry.guildId} channel=${entry.channelId} reason=${reason}: ${formatErrorMessage(passthroughErr)}`,
      );
      return false;
    }
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry) {
    entry.decryptFailureCount = 0;
    entry.lastDecryptFailureAt = 0;
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry) {
    const active = this.sessions.get(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.leave({ guildId: entry.guildId });
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.join({ guildId: entry.guildId, channelId: entry.channelId });
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }

  private resolveSpeakerIsOwner(params: { id: string; name?: string; tag?: string }): boolean {
    return resolveDiscordOwnerAccess({
      allowFrom: this.ownerAllowFrom,
      sender: {
        id: params.id,
        name: params.name,
        tag: params.tag,
      },
      allowNameMatching: this.allowDangerousNameMatching,
    }).ownerAllowed;
  }

  private resolveSpeakerContextCacheKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  private getCachedSpeakerContext(
    guildId: string,
    userId: string,
  ):
    | {
        label: string;
        senderIsOwner: boolean;
      }
    | undefined {
    const key = this.resolveSpeakerContextCacheKey(guildId, userId);
    const cached = this.speakerContextCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.speakerContextCache.delete(key);
      return undefined;
    }
    return {
      label: cached.label,
      senderIsOwner: cached.senderIsOwner,
    };
  }

  private setCachedSpeakerContext(
    guildId: string,
    userId: string,
    context: { label: string; senderIsOwner: boolean },
  ): void {
    const key = this.resolveSpeakerContextCacheKey(guildId, userId);
    this.speakerContextCache.set(key, {
      label: context.label,
      senderIsOwner: context.senderIsOwner,
      expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS,
    });
  }

  private async resolveSpeakerContext(
    guildId: string,
    userId: string,
  ): Promise<{
    label: string;
    senderIsOwner: boolean;
  }> {
    const cached = this.getCachedSpeakerContext(guildId, userId);
    if (cached) {
      return cached;
    }
    const identity = await this.resolveSpeakerIdentity(guildId, userId);
    const context = {
      label: identity.label,
      senderIsOwner: this.resolveSpeakerIsOwner({
        id: identity.id,
        name: identity.name,
        tag: identity.tag,
      }),
    };
    this.setCachedSpeakerContext(guildId, userId, context);
    return context;
  }

  private async resolveSpeakerIdentity(
    guildId: string,
    userId: string,
  ): Promise<{
    id: string;
    label: string;
    name?: string;
    tag?: string;
  }> {
    try {
      const member = await this.params.client.fetchMember(guildId, userId);
      const username = member.user?.username ?? undefined;
      return {
        id: userId,
        label: member.nickname ?? member.user?.globalName ?? username ?? userId,
        name: username,
        tag: member.user ? formatDiscordUserTag(member.user) : undefined,
      };
    } catch {
      try {
        const user = await this.params.client.fetchUser(userId);
        const username = user.username ?? undefined;
        return {
          id: userId,
          label: user.globalName ?? username ?? userId,
          name: username,
          tag: formatDiscordUserTag(user),
        };
      } catch {
        return { id: userId, label: userId };
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
