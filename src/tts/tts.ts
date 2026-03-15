import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import type {
  TtsConfig,
  TtsAutoMode,
  TtsMode,
  TtsProvider,
  TtsModelOverrideConfig,
} from "../config/types.tts.js";
import { resolveExtensionHostTtsPayloadPlan } from "../extension-host/tts-payload.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsEnabled,
  isExtensionHostTtsSummarizationEnabled,
  normalizeExtensionHostTtsAutoMode,
  resolveExtensionHostTtsAutoMode,
  resolveExtensionHostTtsPrefsPath,
  setExtensionHostTtsAutoMode,
  setExtensionHostTtsEnabled,
  setExtensionHostTtsMaxLength,
  setExtensionHostTtsProvider,
  setExtensionHostTtsSummarizationEnabled,
} from "../extension-host/tts-preferences.js";
import {
  executeExtensionHostTextToSpeech,
  executeExtensionHostTextToSpeechTelephony,
  isExtensionHostTtsVoiceBubbleChannel,
  resolveExtensionHostEdgeOutputFormat,
  resolveExtensionHostTtsOutputFormat,
} from "../extension-host/tts-runtime-execution.js";
import {
  EXTENSION_HOST_TTS_PROVIDER_IDS,
  isExtensionHostTtsProviderConfigured,
  resolveExtensionHostTtsApiKey,
  resolveExtensionHostTtsProviderOrder,
} from "../extension-host/tts-runtime-registry.js";
import {
  resolveExtensionHostTtsProvider,
  resolveExtensionHostTtsRequestSetup,
} from "../extension-host/tts-runtime-setup.js";
import {
  getExtensionHostLastTtsAttempt,
  setExtensionHostLastTtsAttempt,
  type ExtensionHostTtsStatusEntry,
} from "../extension-host/tts-status.js";
import { logVerbose } from "../globals.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  isValidVoiceId,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveOpenAITtsInstructions,
  summarizeText,
} from "./tts-core.js";
export { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from "./tts-core.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_LENGTH = 4096;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_VOICE = "alloy";
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

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  sampleRate?: number;
};

type TtsStatusEntry = ExtensionHostTtsStatusEntry;

export const normalizeTtsAutoMode = normalizeExtensionHostTtsAutoMode;

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

export const resolveTtsPrefsPath = resolveExtensionHostTtsPrefsPath;

export const resolveTtsAutoMode = resolveExtensionHostTtsAutoMode;

export function buildTtsSystemPromptHint(cfg: OpenClawConfig): string | undefined {
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({ config, prefsPath });
  if (autoMode === "off") {
    return undefined;
  }
  const maxLength = getExtensionHostTtsMaxLength(prefsPath);
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

export const isTtsEnabled = isExtensionHostTtsEnabled;

export const setTtsAutoMode = setExtensionHostTtsAutoMode;

export const setTtsEnabled = setExtensionHostTtsEnabled;

export const getTtsProvider = resolveExtensionHostTtsProvider;

export const setTtsProvider = setExtensionHostTtsProvider;

export const getTtsMaxLength = getExtensionHostTtsMaxLength;

export const setTtsMaxLength = setExtensionHostTtsMaxLength;

export const isSummarizationEnabled = isExtensionHostTtsSummarizationEnabled;

export const setSummarizationEnabled = setExtensionHostTtsSummarizationEnabled;

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return getExtensionHostLastTtsAttempt();
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  setExtensionHostLastTtsAttempt(entry);
}

export const TTS_PROVIDERS = EXTENSION_HOST_TTS_PROVIDER_IDS;

export const resolveTtsApiKey = resolveExtensionHostTtsApiKey;

export const resolveTtsProviderOrder = resolveExtensionHostTtsProviderOrder;

export const isTtsProviderConfigured = isExtensionHostTtsProviderConfigured;

export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
}): Promise<TtsResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const setup = resolveExtensionHostTtsRequestSetup({
    text: params.text,
    config,
    prefsPath,
    providerOverride: params.overrides?.provider,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  return executeExtensionHostTextToSpeech({
    text: params.text,
    config: setup.config,
    providers: setup.providers,
    channel: params.channel,
    overrides: params.overrides,
  });
}

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
}): Promise<TtsTelephonyResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const setup = resolveExtensionHostTtsRequestSetup({
    text: params.text,
    config,
    prefsPath,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  return executeExtensionHostTextToSpeechTelephony({
    text: params.text,
    config: setup.config,
    providers: setup.providers,
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
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const plan = await resolveExtensionHostTtsPayloadPlan({
    payload: params.payload,
    cfg: params.cfg,
    config,
    prefsPath,
    kind: params.kind,
    inboundAudio: params.inboundAudio,
    ttsAuto: params.ttsAuto,
  });
  if (plan.kind === "skip") {
    return plan.payload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: plan.textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: plan.overrides,
  });

  if (result.success && result.audioPath) {
    setExtensionHostLastTtsAttempt({
      timestamp: Date.now(),
      success: true,
      textLength: (params.payload.text ?? "").length,
      summarized: plan.wasSummarized,
      provider: result.provider,
      latencyMs: result.latencyMs,
    });

    const shouldVoice =
      isExtensionHostTtsVoiceBubbleChannel(params.channel) && result.voiceCompatible === true;
    const finalPayload = {
      ...plan.nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
    return finalPayload;
  }

  setExtensionHostLastTtsAttempt({
    timestamp: Date.now(),
    success: false,
    textLength: (params.payload.text ?? "").length,
    summarized: plan.wasSummarized,
    error: result.error,
  });

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
  resolveOutputFormat: resolveExtensionHostTtsOutputFormat,
  resolveEdgeOutputFormat: resolveExtensionHostEdgeOutputFormat,
};
