import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ReplyPayload } from "../auto-reply/types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  OpenAiTtsResponseFormat,
  OpenAiTtsStreamFormat,
  TtsConfig,
  TtsAutoMode,
  TtsMode,
  TtsProvider,
  TtsModelOverrideConfig,
} from "../config/types.tts.js";
import { logVerbose } from "../globals.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { stripMarkdown } from "../line/markdown-to-line.js";
import { isVoiceCompatibleAudio } from "../media/audio.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  edgeTTS,
  elevenLabsTTS,
  inferEdgeExtension,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  isValidVoiceId,
  isValidOpenAIResponseFormat,
  isValidOpenAIStreamFormat,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_RESPONSE_FORMATS,
  OPENAI_TTS_STREAM_FORMATS,
  OPENAI_TTS_VOICES,
  openaiTTS,
  openaiTTSReadable,
  parseTtsDirectives,
  scheduleCleanup,
  summarizeText,
} from "./tts-core.js";
export {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_RESPONSE_FORMATS,
  OPENAI_TTS_STREAM_FORMATS,
  OPENAI_TTS_VOICES,
} from "./tts-core.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_VOICE = "alloy";
const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODELS_WITH_IMPLICIT_INSTRUCTIONS = new Set<string>(["gpt-4o-mini-tts"]);
const OPENAI_MODELS_WITH_IMPLICIT_STREAM = new Set<string>(["gpt-4o-mini-tts"]);
const DEFAULT_OPENAI_RESPONSE_FORMAT: OpenAiTtsResponseFormat = "mp3";
const DEFAULT_OPENAI_STREAM_FORMAT: OpenAiTtsStreamFormat = "audio";
const DEFAULT_OPENAI_SPEED = 1;
const DEFAULT_EDGE_VOICE = "en-US-MichelleNeural";
const DEFAULT_EDGE_LANG = "en-US";
const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.0,
  useSpeakerBoost: true,
  speed: 1.0,
};

const TELEGRAM_OUTPUT = {
  openai: "opus" as const,
  // ElevenLabs output formats use codec_sample_rate_bitrate naming.
  // Opus @ 48kHz/64kbps is a good voice-note tradeoff for Telegram.
  elevenlabs: "opus_48000_64",
};

const DEFAULT_OUTPUT = {
  openai: "mp3" as const,
  elevenlabs: "mp3_44100_128",
};

const TELEPHONY_OUTPUT = {
  openai: { format: "pcm" as const, sampleRate: 24000 },
  elevenlabs: { format: "pcm_22050", sampleRate: 22050 },
};

const TTS_AUTO_MODES = new Set<TtsAutoMode>(["off", "always", "inbound", "tagged"]);

export type ResolvedTtsConfig = {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  elevenlabs: {
    apiKey?: string;
    baseUrl: string;
    voiceId: string;
    modelId: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings: {
      stability: number;
      similarityBoost: number;
      style: number;
      useSpeakerBoost: boolean;
      speed: number;
    };
  };
  openai: {
    apiKey?: string;
    baseUrl?: string;
    model: string;
    voice: string;
    instructions?: string;
    stream: boolean;
    streamConfigured: boolean;
    responseFormat: OpenAiTtsResponseFormat;
    responseFormatConfigured: boolean;
    speed: number;
    speedConfigured: boolean;
    streamFormat: OpenAiTtsStreamFormat;
    streamFormatConfigured: boolean;
  };
  edge: {
    enabled: boolean;
    voice: string;
    lang: string;
    outputFormat: string;
    outputFormatConfigured: boolean;
    pitch?: string;
    rate?: string;
    volume?: string;
    saveSubtitles: boolean;
    proxy?: string;
    timeoutMs?: number;
  };
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
};

type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};

export type ResolvedTtsModelOverrides = {
  enabled: boolean;
  allowText: boolean;
  allowProvider: boolean;
  allowVoice: boolean;
  allowModelId: boolean;
  allowVoiceSettings: boolean;
  allowNormalization: boolean;
  allowSeed: boolean;
  allowInstructions: boolean;
  allowStream: boolean;
  allowResponseFormat: boolean;
  allowSpeed: boolean;
  allowStreamFormat: boolean;
};

export type TtsDirectiveOverrides = {
  ttsText?: string;
  provider?: TtsProvider;
  openai?: {
    voice?: string;
    model?: string;
    instructions?: string;
    stream?: boolean;
    responseFormat?: OpenAiTtsResponseFormat;
    speed?: number;
    streamFormat?: OpenAiTtsStreamFormat;
  };
  elevenlabs?: {
    voiceId?: string;
    modelId?: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: Partial<ResolvedTtsConfig["elevenlabs"]["voiceSettings"]>;
  };
};

export type TtsDirectiveParseResult = {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
};

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
};

export type TtsStreamResult = {
  success: boolean;
  audioStream?: Readable;
  progressive?: boolean;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
};

export type TtsStreamRequest = {
  enabled?: boolean;
  timeoutMs?: number;
  fallbackToBuffered?: boolean;
};

export type TtsDeliveryResult =
  | (TtsStreamResult & {
      success: true;
      delivery: "stream";
      fallbackFromError?: never;
      audioPath?: never;
    })
  | (TtsResult & {
      success: true;
      delivery: "buffered";
      fallbackFromError?: string;
      audioStream?: never;
      progressive?: never;
    })
  | {
      success: false;
      delivery: "stream" | "buffered";
      error: string;
      fallbackFromError?: string;
    };

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  sampleRate?: number;
};

type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  latencyMs?: number;
  error?: string;
};

let lastTtsAttempt: TtsStatusEntry | undefined;

export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (TTS_AUTO_MODES.has(normalized as TtsAutoMode)) {
    return normalized as TtsAutoMode;
  }
  return undefined;
}

function resolveModelOverridePolicy(
  overrides: TtsModelOverrideConfig | undefined,
): ResolvedTtsModelOverrides {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
      allowInstructions: false,
      allowStream: false,
      allowResponseFormat: false,
      allowSpeed: false,
      allowStreamFormat: false,
    };
  }
  const allow = (value: boolean | undefined, defaultValue = true) => value ?? defaultValue;
  return {
    enabled: true,
    allowText: allow(overrides?.allowText),
    // Provider switching is higher-impact than voice/style tweaks; keep opt-in.
    allowProvider: allow(overrides?.allowProvider, false),
    allowVoice: allow(overrides?.allowVoice),
    allowModelId: allow(overrides?.allowModelId),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    allowNormalization: allow(overrides?.allowNormalization),
    allowSeed: allow(overrides?.allowSeed),
    allowInstructions: allow(overrides?.allowInstructions),
    allowStream: allow(overrides?.allowStream),
    allowResponseFormat: allow(overrides?.allowResponseFormat),
    allowSpeed: allow(overrides?.allowSpeed),
    allowStreamFormat: allow(overrides?.allowStreamFormat),
  };
}

export function resolveTtsConfig(cfg: OpenClawConfig): ResolvedTtsConfig {
  const raw: TtsConfig = cfg.messages?.tts ?? {};
  const rawOpenAi = raw.openai ?? {};
  const hasOpenAiSetting = (key: keyof NonNullable<TtsConfig["openai"]>) =>
    Object.prototype.hasOwnProperty.call(rawOpenAi, key);
  const providerSource = raw.provider ? "config" : "default";
  const edgeOutputFormat = raw.edge?.outputFormat?.trim();
  const auto = normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
  return {
    auto,
    mode: raw.mode ?? "final",
    provider: raw.provider ?? "edge",
    providerSource,
    summaryModel: raw.summaryModel?.trim() || undefined,
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    elevenlabs: {
      apiKey: raw.elevenlabs?.apiKey,
      baseUrl: raw.elevenlabs?.baseUrl?.trim() || DEFAULT_ELEVENLABS_BASE_URL,
      voiceId: raw.elevenlabs?.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
      modelId: raw.elevenlabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID,
      seed: raw.elevenlabs?.seed,
      applyTextNormalization: raw.elevenlabs?.applyTextNormalization,
      languageCode: raw.elevenlabs?.languageCode,
      voiceSettings: {
        stability:
          raw.elevenlabs?.voiceSettings?.stability ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
        similarityBoost:
          raw.elevenlabs?.voiceSettings?.similarityBoost ??
          DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
        style: raw.elevenlabs?.voiceSettings?.style ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
        useSpeakerBoost:
          raw.elevenlabs?.voiceSettings?.useSpeakerBoost ??
          DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
        speed: raw.elevenlabs?.voiceSettings?.speed ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
      },
    },
    openai: {
      apiKey: raw.openai?.apiKey,
      baseUrl: raw.openai?.baseUrl?.trim() || undefined,
      model: raw.openai?.model ?? DEFAULT_OPENAI_MODEL,
      voice: raw.openai?.voice ?? DEFAULT_OPENAI_VOICE,
      instructions: raw.openai?.instructions?.trim() || undefined,
      stream: raw.openai?.stream ?? false,
      streamConfigured: hasOpenAiSetting("stream"),
      responseFormat: raw.openai?.responseFormat ?? DEFAULT_OPENAI_RESPONSE_FORMAT,
      responseFormatConfigured: Boolean(raw.openai?.responseFormat),
      speed: raw.openai?.speed ?? DEFAULT_OPENAI_SPEED,
      speedConfigured: hasOpenAiSetting("speed"),
      streamFormat: raw.openai?.streamFormat ?? DEFAULT_OPENAI_STREAM_FORMAT,
      streamFormatConfigured: hasOpenAiSetting("streamFormat"),
    },
    edge: {
      enabled: raw.edge?.enabled ?? true,
      voice: raw.edge?.voice?.trim() || DEFAULT_EDGE_VOICE,
      lang: raw.edge?.lang?.trim() || DEFAULT_EDGE_LANG,
      outputFormat: edgeOutputFormat || DEFAULT_EDGE_OUTPUT_FORMAT,
      outputFormatConfigured: Boolean(edgeOutputFormat),
      pitch: raw.edge?.pitch?.trim() || undefined,
      rate: raw.edge?.rate?.trim() || undefined,
      volume: raw.edge?.volume?.trim() || undefined,
      saveSubtitles: raw.edge?.saveSubtitles ?? false,
      proxy: raw.edge?.proxy?.trim() || undefined,
      timeoutMs: raw.edge?.timeoutMs,
    },
    prefsPath: raw.prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  if (config.prefsPath?.trim()) {
    return resolveUserPath(config.prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(CONFIG_DIR, "settings", "tts.json");
}

function resolveTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

export function resolveTtsAutoMode(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
}): TtsAutoMode {
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(params.prefsPath));
  if (prefsAuto) {
    return prefsAuto;
  }
  return params.config.auto;
}

export function buildTtsSystemPromptHint(cfg: OpenClawConfig): string | undefined {
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({ config, prefsPath });
  if (autoMode === "off") {
    return undefined;
  }
  const maxLength = getTtsMaxLength(prefsPath);
  const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : autoMode === "tagged"
        ? "Only use TTS when you include [[tts]] or [[tts:text]] tags."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    `Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function updatePrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

export function isTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updatePrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  const prefs = readPrefs(prefsPath);
  if (prefs.tts?.provider) {
    return prefs.tts.provider;
  }
  if (config.providerSource === "config") {
    return config.provider;
  }

  if (resolveTtsApiKey(config, "openai")) {
    return "openai";
  }
  if (resolveTtsApiKey(config, "elevenlabs")) {
    return "elevenlabs";
  }
  return "edge";
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider };
  });
}

export function getTtsMaxLength(prefsPath: string): number {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

/** Channels that require opus audio and support voice-bubble playback */
const VOICE_BUBBLE_CHANNELS = new Set(["telegram", "feishu", "whatsapp"]);

function resolveOpenAiExtension(responseFormat: OpenAiTtsResponseFormat): string {
  switch (responseFormat) {
    case "mp3":
      return ".mp3";
    case "opus":
      return ".opus";
    case "aac":
      return ".aac";
    case "flac":
      return ".flac";
    case "wav":
      return ".wav";
    case "pcm":
      return ".pcm";
    default:
      return ".bin";
  }
}

function resolveOpenAiResponseFormat(
  config: ResolvedTtsConfig,
  channelId?: string | null,
): OpenAiTtsResponseFormat {
  if (config.openai.responseFormatConfigured) {
    return config.openai.responseFormat;
  }
  if (channelId && VOICE_BUBBLE_CHANNELS.has(channelId)) {
    return TELEGRAM_OUTPUT.openai;
  }
  return DEFAULT_OUTPUT.openai;
}

function resolveElevenLabsExtension(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("opus")) {
    return ".opus";
  }
  if (normalized.includes("flac")) {
    return ".flac";
  }
  if (normalized.includes("aac")) {
    return ".aac";
  }
  if (normalized.includes("wav") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}

function resolveOutputFormat(config: ResolvedTtsConfig, channelId?: string | null) {
  const openai = resolveOpenAiResponseFormat(config, channelId);
  const isVoiceBubble = Boolean(channelId && VOICE_BUBBLE_CHANNELS.has(channelId));
  const elevenlabs = isVoiceBubble ? TELEGRAM_OUTPUT.elevenlabs : DEFAULT_OUTPUT.elevenlabs;
  return {
    openai,
    openaiExtension: resolveOpenAiExtension(openai),
    elevenlabs,
    openaiVoiceCompatible: openai === "opus",
    elevenlabsVoiceCompatible: isVoiceBubble,
  };
}

function resolveChannelId(channel: string | undefined): ChannelId | null {
  return channel ? normalizeChannelId(channel) : null;
}

function resolveEdgeOutputFormat(config: ResolvedTtsConfig): string {
  return config.edge.outputFormat;
}

export function resolveTtsApiKey(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
): string | undefined {
  if (provider === "elevenlabs") {
    return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  }
  if (provider === "openai") {
    return config.openai.apiKey || process.env.OPENAI_API_KEY;
  }
  return undefined;
}

export const TTS_PROVIDERS = ["openai", "elevenlabs", "edge"] as const;

export function resolveTtsProviderOrder(primary: TtsProvider): TtsProvider[] {
  return [primary, ...TTS_PROVIDERS.filter((provider) => provider !== primary)];
}

export function isTtsProviderConfigured(config: ResolvedTtsConfig, provider: TtsProvider): boolean {
  if (provider === "edge") {
    return config.edge.enabled;
  }
  return Boolean(resolveTtsApiKey(config, provider));
}

function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${error.message}`;
}

function resolvePrimaryTtsProvider(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  overrides?: TtsDirectiveOverrides;
}): TtsProvider {
  return params.overrides?.provider ?? getTtsProvider(params.config, params.prefsPath);
}

function resolveTtsStreamTimeoutMs(config: ResolvedTtsConfig, stream?: TtsStreamRequest): number {
  return stream?.timeoutMs ?? config.timeoutMs;
}

function resolveTtsStreamEnabled(params: {
  config: ResolvedTtsConfig;
  overrides?: TtsDirectiveOverrides;
  stream?: TtsStreamRequest;
}): boolean {
  if (params.stream?.enabled != null) {
    return params.stream.enabled;
  }

  const openaiOverrides = params.overrides?.openai ?? {};
  if (Object.prototype.hasOwnProperty.call(openaiOverrides, "stream")) {
    return openaiOverrides.stream === true;
  }

  if (!params.config.openai.stream) {
    return false;
  }

  const model = openaiOverrides.model ?? params.config.openai.model;
  return supportsImplicitOpenAiStream(model, params.config.openai.baseUrl);
}

function resolveOpenAiBaseUrl(baseUrl?: string): string {
  return (
    baseUrl?.trim() ||
    process.env.OPENAI_TTS_BASE_URL?.trim() ||
    DEFAULT_OPENAI_TTS_BASE_URL
  ).replace(/\/+$/, "");
}

function supportsImplicitOpenAiInstructions(model: string, baseUrl?: string): boolean {
  if (resolveOpenAiBaseUrl(baseUrl) !== DEFAULT_OPENAI_TTS_BASE_URL) {
    return true;
  }
  return OPENAI_MODELS_WITH_IMPLICIT_INSTRUCTIONS.has(model);
}

function supportsImplicitOpenAiStream(model: string, baseUrl?: string): boolean {
  if (resolveOpenAiBaseUrl(baseUrl) !== DEFAULT_OPENAI_TTS_BASE_URL) {
    return true;
  }
  return OPENAI_MODELS_WITH_IMPLICIT_STREAM.has(model);
}

function resolveOpenAiInstructions(params: {
  model: string;
  baseUrl?: string;
  configInstructions?: string;
  overrideInstructions?: string;
  hasExplicitOverride: boolean;
}): { instructions?: string; explicit: boolean } {
  if (params.hasExplicitOverride) {
    return {
      instructions: params.overrideInstructions?.trim() || undefined,
      explicit: true,
    };
  }

  const normalized = params.configInstructions?.trim();
  if (!normalized) {
    return { instructions: undefined, explicit: false };
  }
  if (!supportsImplicitOpenAiInstructions(params.model, params.baseUrl)) {
    return { instructions: undefined, explicit: false };
  }
  return { instructions: normalized, explicit: false };
}

function resolveOpenAiStream(params: {
  model: string;
  baseUrl?: string;
  configStream: boolean;
  overrideStream?: boolean;
  hasExplicitOverride: boolean;
}): { stream: boolean; explicit: boolean } {
  if (params.hasExplicitOverride) {
    return {
      stream: params.overrideStream === true,
      explicit: true,
    };
  }

  if (!params.configStream) {
    return { stream: false, explicit: false };
  }
  if (!supportsImplicitOpenAiStream(params.model, params.baseUrl)) {
    return { stream: false, explicit: false };
  }
  return { stream: true, explicit: false };
}

function resolveOpenAIDirectives(params: {
  config: ResolvedTtsConfig;
  channelId?: string | null;
  streaming?: boolean;
  telephony?: boolean;
  overrides?: TtsDirectiveOverrides;
}) {
  const openaiOverrides = params.overrides?.openai ?? {};
  const hasOverride = (key: keyof NonNullable<TtsDirectiveOverrides["openai"]>) =>
    Object.prototype.hasOwnProperty.call(openaiOverrides, key);
  const model = params.overrides?.openai?.model ?? params.config.openai.model;
  const baseUrl = params.config.openai.baseUrl;
  const instructions = resolveOpenAiInstructions({
    model,
    baseUrl,
    configInstructions: params.config.openai.instructions,
    overrideInstructions: params.overrides?.openai?.instructions,
    hasExplicitOverride: hasOverride("instructions"),
  });
  const stream = resolveOpenAiStream({
    model,
    baseUrl,
    configStream: params.config.openai.stream,
    overrideStream: params.overrides?.openai?.stream,
    hasExplicitOverride: hasOverride("stream"),
  });
  const useVoiceBubbleResponseFormat =
    params.telephony !== true &&
    Boolean(params.channelId && VOICE_BUBBLE_CHANNELS.has(params.channelId));
  const responseFormatExplicit =
    params.telephony === true ||
    hasOverride("responseFormat") ||
    params.config.openai.responseFormatConfigured ||
    useVoiceBubbleResponseFormat;
  const responseFormat = responseFormatExplicit
    ? params.telephony === true
      ? TELEPHONY_OUTPUT.openai.format
      : hasOverride("responseFormat")
        ? params.overrides?.openai?.responseFormat
        : params.config.openai.responseFormatConfigured
          ? params.config.openai.responseFormat
          : resolveOpenAiResponseFormat(params.config, params.channelId)
    : undefined;
  if (responseFormat && !isValidOpenAIResponseFormat(responseFormat)) {
    throw new Error(
      `openai: invalid responseFormat "${String(responseFormat)}"; valid values: ${OPENAI_TTS_RESPONSE_FORMATS.join(", ")}`,
    );
  }
  if (params.telephony !== true && responseFormat === "pcm") {
    throw new Error(
      "openai: responseFormat=pcm is only supported by telephony output. Use wav/opus/mp3 for message playback.",
    );
  }

  const speedExplicit = hasOverride("speed") || params.config.openai.speedConfigured;
  const speed = speedExplicit
    ? (params.overrides?.openai?.speed ?? params.config.openai.speed)
    : undefined;
  if (speed != null && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new Error("openai: speed must be between 0.25 and 4.0");
  }

  const streamFormatExplicit =
    hasOverride("streamFormat") || params.config.openai.streamFormatConfigured;
  const streamFormat = streamFormatExplicit
    ? (params.overrides?.openai?.streamFormat ?? params.config.openai.streamFormat)
    : undefined;
  if (streamFormat && !isValidOpenAIStreamFormat(streamFormat)) {
    throw new Error(
      `openai: invalid streamFormat "${String(streamFormat)}"; valid values: ${OPENAI_TTS_STREAM_FORMATS.join(", ")}`,
    );
  }
  if ((params.streaming || stream.stream) && streamFormat === "sse") {
    throw new Error(
      "openai: streamFormat=sse is not supported by OpenClaw audio playback yet; use streamFormat=audio.",
    );
  }

  return {
    baseUrl,
    model,
    voice: params.overrides?.openai?.voice ?? params.config.openai.voice,
    instructions: instructions.instructions,
    instructionsExplicit: instructions.explicit,
    stream: stream.stream,
    responseFormat,
    speed,
    streamFormat,
  };
}

export function isTtsStreamingProviderSupported(provider: TtsProvider): boolean {
  return provider === "openai";
}

export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
}): Promise<TtsResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const channelId = resolveChannelId(params.channel);
  const output = resolveOutputFormat(config, channelId);

  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, prefsPath);
  const overrideProvider = params.overrides?.provider;
  const provider = overrideProvider ?? userProvider;
  const providers = resolveTtsProviderOrder(provider);

  const errors: string[] = [];

  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      if (provider === "edge") {
        if (!config.edge.enabled) {
          errors.push("edge: disabled");
          continue;
        }

        const tempRoot = resolvePreferredOpenClawTmpDir();
        mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
        const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
        let edgeOutputFormat = resolveEdgeOutputFormat(config);
        const fallbackEdgeOutputFormat =
          edgeOutputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

        const attemptEdgeTts = async (outputFormat: string) => {
          const extension = inferEdgeExtension(outputFormat);
          const audioPath = path.join(tempDir, `voice-${Date.now()}${extension}`);
          await edgeTTS({
            text: params.text,
            outputPath: audioPath,
            config: {
              ...config.edge,
              outputFormat,
            },
            timeoutMs: config.timeoutMs,
          });
          return { audioPath, outputFormat };
        };

        let edgeResult: { audioPath: string; outputFormat: string };
        try {
          edgeResult = await attemptEdgeTts(edgeOutputFormat);
        } catch (err) {
          if (fallbackEdgeOutputFormat && fallbackEdgeOutputFormat !== edgeOutputFormat) {
            logVerbose(
              `TTS: Edge output ${edgeOutputFormat} failed; retrying with ${fallbackEdgeOutputFormat}.`,
            );
            edgeOutputFormat = fallbackEdgeOutputFormat;
            try {
              edgeResult = await attemptEdgeTts(edgeOutputFormat);
            } catch (fallbackErr) {
              try {
                rmSync(tempDir, { recursive: true, force: true });
              } catch {
                // ignore cleanup errors
              }
              throw fallbackErr;
            }
          } else {
            try {
              rmSync(tempDir, { recursive: true, force: true });
            } catch {
              // ignore cleanup errors
            }
            throw err;
          }
        }

        scheduleCleanup(tempDir);
        const voiceCompatible = isVoiceCompatibleAudio({ fileName: edgeResult.audioPath });

        return {
          success: true,
          audioPath: edgeResult.audioPath,
          latencyMs: Date.now() - providerStart,
          provider,
          outputFormat: edgeResult.outputFormat,
          voiceCompatible,
        };
      }

      const apiKey = resolveTtsApiKey(config, provider);
      if (!apiKey) {
        errors.push(`${provider}: no API key`);
        continue;
      }

      let audioBuffer: Buffer;
      if (provider === "elevenlabs") {
        const voiceIdOverride = params.overrides?.elevenlabs?.voiceId;
        const modelIdOverride = params.overrides?.elevenlabs?.modelId;
        const voiceSettings = {
          ...config.elevenlabs.voiceSettings,
          ...params.overrides?.elevenlabs?.voiceSettings,
        };
        const seedOverride = params.overrides?.elevenlabs?.seed;
        const normalizationOverride = params.overrides?.elevenlabs?.applyTextNormalization;
        const languageOverride = params.overrides?.elevenlabs?.languageCode;
        audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          baseUrl: config.elevenlabs.baseUrl,
          voiceId: voiceIdOverride ?? config.elevenlabs.voiceId,
          modelId: modelIdOverride ?? config.elevenlabs.modelId,
          outputFormat: output.elevenlabs,
          seed: seedOverride ?? config.elevenlabs.seed,
          applyTextNormalization: normalizationOverride ?? config.elevenlabs.applyTextNormalization,
          languageCode: languageOverride ?? config.elevenlabs.languageCode,
          voiceSettings,
          timeoutMs: config.timeoutMs,
        });
      } else {
        const openaiSettings = resolveOpenAIDirectives({
          config,
          channelId,
          overrides: params.overrides,
        });
        const openaiResult = await openaiTTS({
          text: params.text,
          apiKey,
          baseUrl: openaiSettings.baseUrl,
          model: openaiSettings.model,
          voice: openaiSettings.voice,
          responseFormat: openaiSettings.responseFormat,
          speed: openaiSettings.speed,
          instructions: openaiSettings.instructions,
          instructionsExplicit: openaiSettings.instructionsExplicit,
          stream: openaiSettings.stream,
          streamFormat: openaiSettings.streamFormat,
          timeoutMs: config.timeoutMs,
        });
        audioBuffer = openaiResult.audioBuffer;
        output.openai = openaiResult.outputFormat;
        output.openaiExtension = resolveOpenAiExtension(openaiResult.outputFormat);
        output.openaiVoiceCompatible = openaiResult.outputFormat === "opus";
      }

      const latencyMs = Date.now() - providerStart;

      const tempRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
      const extension =
        provider === "openai"
          ? output.openaiExtension
          : resolveElevenLabsExtension(output.elevenlabs);
      const audioPath = path.join(tempDir, `voice-${Date.now()}${extension}`);
      writeFileSync(audioPath, audioBuffer);
      scheduleCleanup(tempDir);

      return {
        success: true,
        audioPath,
        latencyMs,
        provider,
        outputFormat: provider === "openai" ? output.openai : output.elevenlabs,
        voiceCompatible:
          provider === "openai" ? output.openaiVoiceCompatible : output.elevenlabsVoiceCompatible,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
  };
}

export async function textToSpeechStream(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  stream?: TtsStreamRequest;
}): Promise<TtsStreamResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const channelId = resolveChannelId(params.channel);

  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const provider = resolvePrimaryTtsProvider({
    config,
    prefsPath,
    overrides: params.overrides,
  });

  if (!isTtsStreamingProviderSupported(provider)) {
    return {
      success: false,
      error: `streaming unsupported for provider ${provider}`,
      provider,
    };
  }

  const apiKey = resolveTtsApiKey(config, "openai");
  if (!apiKey) {
    return {
      success: false,
      error: "openai: no API key",
      provider: "openai",
    };
  }

  const streamEnabled = resolveTtsStreamEnabled({
    config,
    overrides: params.overrides,
    stream: params.stream,
  });
  if (!streamEnabled) {
    return {
      success: false,
      error: "streaming disabled",
      provider: "openai",
    };
  }

  const openaiSettings = resolveOpenAIDirectives({
    config,
    channelId,
    streaming: true,
    overrides: params.overrides,
  });

  const providerStart = Date.now();
  try {
    const streamResult = await openaiTTSReadable({
      text: params.text,
      apiKey,
      baseUrl: openaiSettings.baseUrl,
      model: openaiSettings.model,
      voice: openaiSettings.voice,
      responseFormat: openaiSettings.responseFormat,
      speed: openaiSettings.speed,
      instructions: openaiSettings.instructions,
      instructionsExplicit: openaiSettings.instructionsExplicit,
      streamFormat: openaiSettings.streamFormat,
      timeoutMs: resolveTtsStreamTimeoutMs(config, params.stream),
    });
    return {
      success: true,
      audioStream: streamResult.stream,
      progressive: streamResult.progressive,
      latencyMs: Date.now() - providerStart,
      provider: "openai",
      outputFormat: streamResult.outputFormat,
      voiceCompatible: streamResult.outputFormat === "opus",
    };
  } catch (err) {
    return {
      success: false,
      error: formatTtsProviderError("openai", err),
      provider: "openai",
    };
  }
}

export async function textToSpeechWithFallback(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  stream?: TtsStreamRequest;
}): Promise<TtsDeliveryResult> {
  const toBufferedSuccess = (result: TtsResult, fallbackFromError?: string): TtsDeliveryResult => ({
    success: true,
    delivery: "buffered",
    audioPath: result.audioPath,
    latencyMs: result.latencyMs,
    provider: result.provider,
    outputFormat: result.outputFormat,
    voiceCompatible: result.voiceCompatible,
    fallbackFromError,
  });

  const toStreamSuccess = (result: TtsStreamResult): TtsDeliveryResult => ({
    success: true,
    delivery: "stream",
    audioStream: result.audioStream,
    progressive: result.progressive,
    latencyMs: result.latencyMs,
    provider: result.provider,
    outputFormat: result.outputFormat,
    voiceCompatible: result.voiceCompatible,
  });

  const config = resolveTtsConfig(params.cfg);
  const streamEnabled = resolveTtsStreamEnabled({
    config,
    overrides: params.overrides,
    stream: params.stream,
  });
  if (!streamEnabled) {
    const buffered = await textToSpeech(params);
    if (buffered.success) {
      return toBufferedSuccess(buffered);
    }
    return {
      success: false,
      delivery: "buffered",
      error: buffered.error ?? "TTS conversion failed",
    };
  }

  const streamResult = await textToSpeechStream(params);
  if (streamResult.success) {
    return toStreamSuccess(streamResult);
  }

  if (params.stream?.fallbackToBuffered === false) {
    return {
      success: false,
      delivery: "stream",
      error: streamResult.error ?? "TTS streaming failed",
    };
  }

  const buffered = await textToSpeech({
    ...params,
    overrides: {
      ...params.overrides,
      openai: {
        ...params.overrides?.openai,
        stream: false,
      },
    },
  });
  if (buffered.success) {
    return toBufferedSuccess(buffered, streamResult.error);
  }

  return {
    success: false,
    delivery: "buffered",
    error: buffered.error ?? "TTS conversion failed",
    fallbackFromError: streamResult.error,
  };
}

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
}): Promise<TtsTelephonyResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);

  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, prefsPath);
  const providers = resolveTtsProviderOrder(userProvider);

  const errors: string[] = [];

  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      if (provider === "edge") {
        errors.push("edge: unsupported for telephony");
        continue;
      }

      const apiKey = resolveTtsApiKey(config, provider);
      if (!apiKey) {
        errors.push(`${provider}: no API key`);
        continue;
      }

      if (provider === "elevenlabs") {
        const output = TELEPHONY_OUTPUT.elevenlabs;
        const audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          baseUrl: config.elevenlabs.baseUrl,
          voiceId: config.elevenlabs.voiceId,
          modelId: config.elevenlabs.modelId,
          outputFormat: output.format,
          seed: config.elevenlabs.seed,
          applyTextNormalization: config.elevenlabs.applyTextNormalization,
          languageCode: config.elevenlabs.languageCode,
          voiceSettings: config.elevenlabs.voiceSettings,
          timeoutMs: config.timeoutMs,
        });

        return {
          success: true,
          audioBuffer,
          latencyMs: Date.now() - providerStart,
          provider,
          outputFormat: output.format,
          sampleRate: output.sampleRate,
        };
      }

      const output = TELEPHONY_OUTPUT.openai;
      const openaiSettings = resolveOpenAIDirectives({ config, telephony: true });
      const openaiResult = await openaiTTS({
        text: params.text,
        apiKey,
        baseUrl: openaiSettings.baseUrl,
        model: openaiSettings.model,
        voice: openaiSettings.voice,
        responseFormat: output.format,
        speed: openaiSettings.speed,
        instructions: openaiSettings.instructions,
        instructionsExplicit: openaiSettings.instructionsExplicit,
        stream: openaiSettings.stream,
        streamFormat: openaiSettings.streamFormat,
        timeoutMs: config.timeoutMs,
      });

      return {
        success: true,
        audioBuffer: openaiResult.audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: openaiResult.outputFormat,
        sampleRate: output.sampleRate,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
  };
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
}): Promise<ReplyPayload> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({
    config,
    prefsPath,
    sessionAuto: params.ttsAuto,
  });
  if (autoMode === "off") {
    return params.payload;
  }

  const text = params.payload.text ?? "";
  const directives = parseTtsDirectives(text, config.modelOverrides, {
    openaiBaseUrl: config.openai.baseUrl,
  });
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }

  const cleanedText = directives.cleanedText;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const ttsText = directives.ttsText?.trim() || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }

  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }

  if (!ttsText.trim()) {
    return nextPayload;
  }
  if (params.payload.mediaUrl || (params.payload.mediaUrls?.length ?? 0) > 0) {
    return nextPayload;
  }
  if (text.includes("MEDIA:")) {
    return nextPayload;
  }
  if (ttsText.trim().length < 10) {
    return nextPayload;
  }

  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      try {
        const summary = await summarizeText({
          text: textForAudio,
          targetLength: maxLength,
          cfg: params.cfg,
          config,
          timeoutMs: config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
          );
          textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
        }
      } catch (err) {
        const error = err as Error;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
      }
    }
  }

  textForAudio = stripMarkdown(textForAudio).trim(); // strip markdown for TTS (### → "hashtag" etc.)
  if (textForAudio.length < 10) {
    return nextPayload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: directives.overrides,
  });

  if (result.success && result.audioPath) {
    lastTtsAttempt = {
      timestamp: Date.now(),
      success: true,
      textLength: text.length,
      summarized: wasSummarized,
      provider: result.provider,
      latencyMs: result.latencyMs,
    };

    const channelId = resolveChannelId(params.channel);
    const shouldVoice =
      channelId !== null && VOICE_BUBBLE_CHANNELS.has(channelId) && result.voiceCompatible === true;
    const finalPayload = {
      ...nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
    return finalPayload;
  }

  lastTtsAttempt = {
    timestamp: Date.now(),
    success: false,
    textLength: text.length,
    summarized: wasSummarized,
    error: result.error,
  };

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return nextPayload;
}

export const _test = {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
  openaiTTS,
  openaiTTSReadable,
};
