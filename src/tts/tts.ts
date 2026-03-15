import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { TtsProvider } from "../config/types.tts.js";
import {
  normalizeExtensionHostTtsConfigAutoMode,
  resolveExtensionHostTtsConfig,
  resolveExtensionHostTtsModelOverridePolicy,
  type ResolvedTtsConfig,
} from "../extension-host/tts-config.js";
import { resolveExtensionHostTtsPayloadPlan } from "../extension-host/tts-payload.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsEnabled,
  isExtensionHostTtsSummarizationEnabled,
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

export const normalizeTtsAutoMode = normalizeExtensionHostTtsConfigAutoMode;

export const resolveTtsConfig = resolveExtensionHostTtsConfig;

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
  resolveModelOverridePolicy: resolveExtensionHostTtsModelOverridePolicy,
  summarizeText,
  resolveOutputFormat: resolveExtensionHostTtsOutputFormat,
  resolveEdgeOutputFormat: resolveExtensionHostEdgeOutputFormat,
};
