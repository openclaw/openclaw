import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { findNormalizedProviderValue } from "../agents/provider-id.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import type {
  TtsConfig,
  TtsAutoMode,
  TtsMode,
  TtsProvider,
  TtsModelOverrideConfig,
} from "../config/types.tts.js";
import { logVerbose } from "../globals.js";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { isVoiceCompatibleAudio } from "../media/audio.js";
import {
  OPENAI_DEFAULT_TTS_MODEL as DEFAULT_OPENAI_MODEL,
  OPENAI_DEFAULT_TTS_VOICE as DEFAULT_OPENAI_VOICE,
} from "../plugins/provider-model-defaults.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "./provider-registry.js";
import type { SpeechVoiceOption } from "./provider-types.js";
import {
  buildTtsProviderRegistryAsync as buildPluginTtsRegistry,
  getTtsProvider as getPluginTtsProvider,
  type TtsProvider as PluginTtsProviderObject,
} from "./providers.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  isValidVoiceId,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  resolveOpenAITtsInstructions,
  parseTtsDirectives,
  scheduleCleanup,
  summarizeText,
} from "./tts-core.js";
export { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from "./tts-core.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
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
  extension: ".opus",
  voiceCompatible: true,
};

const DEFAULT_OUTPUT = {
  openai: "mp3" as const,
  elevenlabs: "mp3_44100_128",
  extension: ".mp3",
  voiceCompatible: false,
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
    baseUrl: string;
    model: string;
    voice: string;
    speed?: number;
    instructions?: string;
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
};

export type TtsDirectiveOverrides = {
  ttsText?: string;
  provider?: TtsProvider;
  openai?: {
    voice?: string;
    model?: string;
    speed?: number;
  };
  elevenlabs?: {
    voiceId?: string;
    modelId?: string;
    outputFormat?: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: Partial<ResolvedTtsConfig["elevenlabs"]["voiceSettings"]>;
  };
  microsoft?: {
    voice?: string;
    outputFormat?: string;
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

export type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
};

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  fileExtension?: string;
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
  };
}

export function resolveTtsConfig(cfg: OpenClawConfig): ResolvedTtsConfig {
  const raw: TtsConfig = cfg.messages?.tts ?? {};
  const providerSource = raw.provider ? "config" : "default";
  const rawMicrosoft = { ...raw.edge, ...raw.microsoft };
  const edgeOutputFormat = rawMicrosoft.outputFormat?.trim();
  const auto = normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
  return {
    auto,
    mode: raw.mode ?? "final",
    provider: normalizeSpeechProviderId(raw.provider) ?? "microsoft",
    providerSource,
    summaryModel: raw.summaryModel?.trim() || undefined,
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    elevenlabs: {
      apiKey: normalizeResolvedSecretInputString({
        value: raw.elevenlabs?.apiKey,
        path: "messages.tts.elevenlabs.apiKey",
      }),
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
      apiKey: normalizeResolvedSecretInputString({
        value: raw.openai?.apiKey,
        path: "messages.tts.openai.apiKey",
      }),
      // Config > env var > default; strip trailing slashes for consistency.
      baseUrl: (
        raw.openai?.baseUrl?.trim() ||
        process.env.OPENAI_TTS_BASE_URL?.trim() ||
        DEFAULT_OPENAI_BASE_URL
      ).replace(/\/+$/, ""),
      model: raw.openai?.model ?? DEFAULT_OPENAI_MODEL,
      voice: raw.openai?.voice ?? DEFAULT_OPENAI_VOICE,
      speed: raw.openai?.speed,
      instructions: raw.openai?.instructions?.trim() || undefined,
    },
    edge: {
      enabled: rawMicrosoft.enabled ?? true,
      voice: rawMicrosoft.voice?.trim() || DEFAULT_EDGE_VOICE,
      lang: rawMicrosoft.lang?.trim() || DEFAULT_EDGE_LANG,
      outputFormat: edgeOutputFormat || DEFAULT_EDGE_OUTPUT_FORMAT,
      outputFormatConfigured: Boolean(edgeOutputFormat),
      pitch: rawMicrosoft.pitch?.trim() || undefined,
      rate: rawMicrosoft.rate?.trim() || undefined,
      volume: rawMicrosoft.volume?.trim() || undefined,
      saveSubtitles: rawMicrosoft.saveSubtitles ?? false,
      proxy: rawMicrosoft.proxy?.trim() || undefined,
      timeoutMs: rawMicrosoft.timeoutMs,
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
  const prefsProvider = normalizeSpeechProviderId(prefs.tts?.provider);
  if (prefsProvider) {
    return prefsProvider;
  }
  if (config.providerSource === "config") {
    return normalizeSpeechProviderId(config.provider) ?? config.provider;
  }

  if (resolveTtsApiKey(config, undefined, "openai")) {
    return "openai";
  }
  if (resolveTtsApiKey(config, undefined, "elevenlabs")) {
    return "elevenlabs";
  }
  return "microsoft";
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider: normalizeSpeechProviderId(provider) ?? provider };
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
const VOICE_BUBBLE_CHANNELS = new Set(["telegram", "feishu", "whatsapp", "matrix"]);

function resolveOutputFormat(channelId?: string | null) {
  if (channelId && VOICE_BUBBLE_CHANNELS.has(channelId)) {
    return TELEGRAM_OUTPUT;
  }
  return DEFAULT_OUTPUT;
}

function resolveChannelId(channel: string | undefined): ChannelId | null {
  return channel ? normalizeChannelId(channel) : null;
}

function resolveEdgeOutputFormat(config: ResolvedTtsConfig): string {
  return config.edge.outputFormat;
}

export function resolveTtsApiKey(
  config: ResolvedTtsConfig,
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  if (provider === "elevenlabs") {
    return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  }
  if (provider === "openai") {
    return config.openai.apiKey || process.env.OPENAI_API_KEY;
  }
  // Check for custom/plugin provider API key in config
  const providerConfig = findNormalizedProviderValue(cfg?.models?.providers, provider);
  if (providerConfig?.apiKey) {
    if (typeof providerConfig.apiKey === "string") {
      return providerConfig.apiKey;
    }
    return normalizeResolvedSecretInputString({
      value: providerConfig.apiKey,
      path: `models.providers.${provider}.apiKey`,
    });
  }
  return undefined;
}

function resolveTtsProviderHeaders(
  cfg: OpenClawConfig,
  provider: string,
): Record<string, string> | undefined {
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, provider);
  const headers = providerConfig?.headers;
  if (!headers) {
    return undefined;
  }
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function resolveTtsProviderBaseUrl(
  config: ResolvedTtsConfig,
  cfg: OpenClawConfig,
  provider: string,
): string | undefined {
  // Only look up from ResolvedTtsConfig for providers that have baseUrl
  let configBaseUrl: string | undefined;
  if (provider === "openai") {
    configBaseUrl = config.openai.baseUrl;
  } else if (provider === "elevenlabs") {
    configBaseUrl = config.elevenlabs.baseUrl;
  }
  if (configBaseUrl) {
    return configBaseUrl;
  }
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, provider);
  return providerConfig?.baseUrl;
}

// TTS_PROVIDERS - edge and microsoft are aliases, use edge as canonical
export const TTS_PROVIDERS = ["openai", "elevenlabs", "edge", "microsoft"] as const;

export function resolveTtsProviderOrder(primary: TtsProvider, cfg?: OpenClawConfig): TtsProvider[] {
  const normalizedPrimary = normalizeSpeechProviderId(primary) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const provider of TTS_PROVIDERS) {
    if (provider !== normalizedPrimary) {
      ordered.add(provider);
    }
  }
  for (const provider of listSpeechProviders(cfg)) {
    const normalized = normalizeSpeechProviderId(provider.id) ?? provider.id;
    if (normalized !== normalizedPrimary) {
      ordered.add(normalized);
    }
  }
  return [...ordered];
}

export function isTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
  cfg?: OpenClawConfig,
): boolean {
  const resolvedProvider = getSpeechProvider(provider, cfg);
  return resolvedProvider?.isConfigured({ cfg, config }) ?? false;
}

function formatTtsProviderError(provider: string, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${error.message}`;
}

function buildTtsFailureResult(errors: string[]): { success: false; error: string } {
  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
  };
}

function resolveReadySpeechProvider(params: {
  provider: TtsProvider;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  errors: string[];
  requireTelephony?: boolean;
}): NonNullable<ReturnType<typeof getSpeechProvider>> | null {
  const resolvedProvider = getSpeechProvider(params.provider, params.cfg);
  if (!resolvedProvider) {
    params.errors.push(`${params.provider}: no provider registered`);
    return null;
  }
  if (!resolvedProvider.isConfigured({ cfg: params.cfg, config: params.config })) {
    params.errors.push(`${params.provider}: not configured`);
    return null;
  }
  if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) {
    params.errors.push(`${params.provider}: unsupported for telephony`);
    return null;
  }
  return resolvedProvider;
}

function resolveTtsRequestSetup(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
}):
  | {
      config: ResolvedTtsConfig;
      providers: string[];
    }
  | {
      error: string;
    } {
  const config = resolveTtsConfig(params.cfg);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, params.prefsPath ?? resolveTtsPrefsPath(config));
  const provider = normalizeSpeechProviderId(params.providerOverride) ?? userProvider;
  return {
    config,
    providers: params.disableFallback ? [provider] : resolveTtsProviderOrder(provider, params.cfg),
  };
}

export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
}): Promise<TtsResult> {
  const synthesis = await synthesizeSpeech(params);
  if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) {
    return buildTtsFailureResult([synthesis.error ?? "TTS conversion failed"]);
  }

  const tempRoot = resolvePreferredOpenClawTmpDir();
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
  const audioPath = path.join(tempDir, `voice-${Date.now()}${synthesis.fileExtension}`);
  writeFileSync(audioPath, synthesis.audioBuffer);
  scheduleCleanup(tempDir);

  return {
    success: true,
    audioPath,
    latencyMs: synthesis.latencyMs,
    provider: synthesis.provider,
    outputFormat: synthesis.outputFormat,
    voiceCompatible: synthesis.voiceCompatible,
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
}): Promise<TtsSynthesisResult> {
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { config, providers: legacyProviders } = setup;
  const channelId = resolveChannelId(params.channel);
  const target = channelId && VOICE_BUBBLE_CHANNELS.has(channelId) ? "voice-note" : "audio-file";

  const pluginTtsRegistry = await buildPluginTtsRegistry(params.cfg);
  const userProvider = getTtsProvider(config, params.prefsPath ?? resolveTtsPrefsPath(config));
  const overrideProvider = params.overrides?.provider;
  const primaryProvider = overrideProvider ?? userProvider;
  const normalizedPrimary = primaryProvider
    ? normalizeSpeechProviderId(primaryProvider)
    : undefined;

  const builtinSet = new Set<string>(TTS_PROVIDERS.map((p) => p.toLowerCase()));
  const customPlugins: string[] = [];
  for (const [, pluginProvider] of pluginTtsRegistry) {
    if (pluginProvider.id !== normalizedPrimary && !builtinSet.has(pluginProvider.id)) {
      customPlugins.push(pluginProvider.id);
    }
  }

  const providerOrder: string[] = [];
  const addedProviders = new Set<string>();

  // If primary is a custom plugin, ensure it heads the provider order
  if (
    normalizedPrimary &&
    !builtinSet.has(normalizedPrimary) &&
    pluginTtsRegistry.has(normalizedPrimary)
  ) {
    providerOrder.push(normalizedPrimary);
    addedProviders.add(normalizedPrimary);
  }

  for (const p of legacyProviders) {
    if (!addedProviders.has(p.toLowerCase())) {
      providerOrder.push(p);
      addedProviders.add(p.toLowerCase());
    }
  }
  for (const p of customPlugins) {
    if (!addedProviders.has(p.toLowerCase())) {
      providerOrder.push(p);
      addedProviders.add(p.toLowerCase());
    }
  }

  const errors: string[] = [];

  for (const provider of providerOrder) {
    const pluginTtsProvider = getPluginTtsProvider(provider, pluginTtsRegistry);
    if (pluginTtsProvider) {
      const providerStart = Date.now();
      try {
        const apiKey = resolveTtsApiKey(config, params.cfg, provider) ?? "";
        const fetchFn = resolveProxyFetchFromEnv();
        const headers = resolveTtsProviderHeaders(params.cfg, provider);
        const baseUrl = resolveTtsProviderBaseUrl(config, params.cfg, provider);
        const allOverrides = params.overrides as Record<string, unknown> | undefined;
        const providerOverrides = allOverrides?.[provider] as
          | { model?: string; modelId?: string; voice?: string; voiceId?: string }
          | undefined;

        // Get defaults from config when not overridden
        // Check ResolvedTtsConfig first, then fall back to models.providers
        const ttsConfigDefaults = config[provider as keyof typeof config] as
          | { model?: string; modelId?: string; voice?: string; voiceId?: string }
          | undefined;
        const modelsProviderDefaults = findNormalizedProviderValue(
          params.cfg.models?.providers,
          provider,
        ) as { model?: string; modelId?: string; voice?: string; voiceId?: string } | undefined;
        const result = await pluginTtsProvider.textToSpeech({
          text: params.text,
          model:
            providerOverrides?.model ?? ttsConfigDefaults?.model ?? modelsProviderDefaults?.model,
          modelId:
            providerOverrides?.modelId ??
            ttsConfigDefaults?.modelId ??
            modelsProviderDefaults?.modelId,
          voice:
            providerOverrides?.voice ?? ttsConfigDefaults?.voice ?? modelsProviderDefaults?.voice,
          voiceId:
            providerOverrides?.voiceId ??
            ttsConfigDefaults?.voiceId ??
            modelsProviderDefaults?.voiceId,
          apiKey,
          baseUrl,
          headers,
          fetchFn,
          timeoutMs: config.timeoutMs,
        });

        const tempRoot = resolvePreferredOpenClawTmpDir();
        mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
        const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
        const mimeSubtype = result.mime.split("/")[1] ?? "mp3";
        const mimeExt = mimeSubtype.split(";")[0].trim() || "mp3";
        const audioPath = path.join(tempDir, `voice-${Date.now()}.${mimeExt}`);
        writeFileSync(audioPath, result.audio);
        scheduleCleanup(tempDir);

        return {
          success: true,
          audioBuffer: result.audio,
          fileExtension: mimeExt.startsWith(".") ? mimeExt : "." + mimeExt,
          latencyMs: Date.now() - providerStart,
          provider,
          outputFormat: result.mime,
          voiceCompatible: isVoiceCompatibleAudio({ fileName: audioPath }),
        };
      } catch (err) {
        const isBuiltin = builtinSet.has(provider.toLowerCase());
        errors.push(formatTtsProviderError(provider, err));
        if (!isBuiltin) {
          continue;
        }
        // Fall through to try built-in for same provider
      }
    }
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg: params.cfg,
        config,
        errors,
      });
      if (!resolvedProvider) {
        continue;
      }
      const synthesis = await resolvedProvider.synthesize({
        text: params.text,
        cfg: params.cfg,
        config,
        target,
        overrides: params.overrides,
      });
      return {
        success: true,
        audioBuffer: synthesis.audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: synthesis.outputFormat,
        voiceCompatible: synthesis.voiceCompatible,
        fileExtension: synthesis.fileExtension,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return buildTtsFailureResult(errors);
}

async function invokePluginTelephonyTts(
  pluginProvider: PluginTtsProviderObject,
  provider: string,
  config: ResolvedTtsConfig,
  cfg: OpenClawConfig,
  text: string,
): Promise<TtsTelephonyResult> {
  const providerStart = Date.now();
  const apiKey = resolveTtsApiKey(config, cfg, provider) ?? "";
  const fetchFn = resolveProxyFetchFromEnv();
  const headers = resolveTtsProviderHeaders(cfg, provider);
  const baseUrl = resolveTtsProviderBaseUrl(config, cfg, provider);
  const ttsConfigDefaults = config[provider as keyof typeof config] as
    | { model?: string; modelId?: string; voice?: string; voiceId?: string }
    | undefined;
  const modelsProviderDefaults = findNormalizedProviderValue(cfg.models?.providers, provider) as
    | { model?: string; modelId?: string; voice?: string; voiceId?: string }
    | undefined;
  const result = await pluginProvider.textToSpeech({
    text,
    model: ttsConfigDefaults?.model ?? modelsProviderDefaults?.model,
    modelId: ttsConfigDefaults?.modelId ?? modelsProviderDefaults?.modelId,
    voice: ttsConfigDefaults?.voice ?? modelsProviderDefaults?.voice,
    voiceId: ttsConfigDefaults?.voiceId ?? modelsProviderDefaults?.voiceId,
    apiKey,
    baseUrl,
    headers,
    fetchFn,
    timeoutMs: config.timeoutMs,
    telephony: true,
  });

  if (!result.sampleRate) {
    throw new Error("plugin TTS result missing required sampleRate for telephony");
  }

  const isPcm =
    result.mime.startsWith("audio/l16") ||
    result.mime === "audio/raw" ||
    result.mime === "audio/pcm";
  if (!isPcm) {
    throw new Error(`plugin TTS result must be PCM format for telephony, got ${result.mime}`);
  }

  const mimeExt = result.mime.split("/")[1]?.split(";")[0].trim() || "pcm";

  return {
    success: true,
    audioBuffer: result.audio,
    fileExtension: `.${mimeExt}`,
    outputFormat: result.mime,
    sampleRate: result.sampleRate,
    latencyMs: Date.now() - providerStart,
    provider,
  };
}

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
}): Promise<TtsTelephonyResult> {
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { config, providers: legacyProviders } = setup;
  const pluginTtsRegistry = await buildPluginTtsRegistry(params.cfg);
  const userProvider = getTtsProvider(config, params.prefsPath ?? resolveTtsPrefsPath(config));
  const normalizedUser = userProvider ? normalizeSpeechProviderId(userProvider) : undefined;

  const builtinSetTelephony = new Set<string>(TTS_PROVIDERS.map((p) => p.toLowerCase()));
  const customPluginsTelephony: string[] = [];
  for (const [, pluginProvider] of pluginTtsRegistry) {
    if (pluginProvider.id !== normalizedUser && !builtinSetTelephony.has(pluginProvider.id)) {
      customPluginsTelephony.push(pluginProvider.id);
    }
  }

  const providers: string[] = [];
  const addedProviders = new Set<string>();

  // If user provider is a custom plugin, ensure it heads the provider order
  if (
    normalizedUser &&
    !builtinSetTelephony.has(normalizedUser) &&
    pluginTtsRegistry.has(normalizedUser)
  ) {
    providers.push(normalizedUser);
    addedProviders.add(normalizedUser);
  }

  for (const p of legacyProviders) {
    if (!addedProviders.has(p.toLowerCase())) {
      providers.push(p);
      addedProviders.add(p.toLowerCase());
    }
  }
  for (const p of customPluginsTelephony) {
    if (!addedProviders.has(p.toLowerCase())) {
      providers.push(p);
      addedProviders.add(p.toLowerCase());
    }
  }

  const errors: string[] = [];

  for (const provider of providers) {
    const pluginTtsProvider = getPluginTtsProvider(provider, pluginTtsRegistry);
    const isBuiltin = builtinSetTelephony.has(provider.toLowerCase());

    if (pluginTtsProvider) {
      try {
        if (isBuiltin) {
          const result = await invokePluginTelephonyTts(
            pluginTtsProvider,
            provider,
            config,
            params.cfg,
            params.text,
          );
          return result;
        } else {
          const result = await invokePluginTelephonyTts(
            pluginTtsProvider,
            provider,
            config,
            params.cfg,
            params.text,
          );
          return result;
        }
      } catch (err) {
        const errorPrefix = isBuiltin ? `${provider} (plugin)` : provider;
        errors.push(formatTtsProviderError(errorPrefix, err));
        if (!isBuiltin) {
          continue;
        }
      }
    }

    // Try built-in provider (or fallback after plugin failed for built-in)
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg: params.cfg,
        config,
        errors,
        requireTelephony: true,
      });
      if (!resolvedProvider?.synthesizeTelephony) {
        continue;
      }
      const synthesis = await resolvedProvider.synthesizeTelephony({
        text: params.text,
        cfg: params.cfg,
        config,
      });

      return {
        success: true,
        audioBuffer: synthesis.audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: synthesis.outputFormat,
        sampleRate: synthesis.sampleRate,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return buildTtsFailureResult(errors);
}

export async function listSpeechVoices(params: {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const provider = normalizeSpeechProviderId(params.provider);
  if (!provider) {
    throw new Error("speech provider id is required");
  }
  const config = params.config ?? (params.cfg ? resolveTtsConfig(params.cfg) : undefined);
  if (!config) {
    throw new Error(`speech provider ${provider} requires cfg or resolved config`);
  }
  const resolvedProvider = getSpeechProvider(provider, params.cfg);
  if (!resolvedProvider) {
    throw new Error(`speech provider ${provider} is not registered`);
  }
  if (!resolvedProvider.listVoices) {
    throw new Error(`speech provider ${provider} does not support voice listing`);
  }
  return await resolvedProvider.listVoices({
    cfg: params.cfg,
    config,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  });
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
}): Promise<ReplyPayload> {
  // Compaction notices are informational UI signals — never synthesise them as speech.
  if (params.payload.isCompactionNotice) {
    return params.payload;
  }
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

  const reply = resolveSendableOutboundReplyParts(params.payload);
  const text = reply.text;
  const directives = parseTtsDirectives(text, config.modelOverrides, config.openai.baseUrl);
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
  if (reply.hasMedia) {
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
  resolveOpenAITtsInstructions,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
  resolveTtsApiKey,
};
