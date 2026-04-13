import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
import type {
  SpeechProviderConfig,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";
import type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
import {
  createLazyFacadeObjectValue,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

// Manual facade. Keep loader boundary explicit and avoid typing this public SDK
// seam through the bundled speech-core runtime surface.
type TtsAttemptReasonCode =
  | "success"
  | "no_provider_registered"
  | "not_configured"
  | "unsupported_for_telephony"
  | "timeout"
  | "provider_error";

type TtsProviderAttempt = {
  provider: string;
  outcome: "success" | "skipped" | "failed";
  reasonCode: TtsAttemptReasonCode;
  latencyMs?: number;
  error?: string;
};

type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  latencyMs?: number;
  error?: string;
};

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type ResolveTtsAutoModeParams = {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
};

type ResolveExplicitTtsOverridesParams = {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
};

type TtsRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
};

type TtsTelephonyRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
};

type ListSpeechVoicesParams = {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
};

type MaybeApplyTtsToPayloadParams = {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
};

type TtsTestFacade = {
  parseTtsDirectives: (...args: unknown[]) => TtsDirectiveParseResult;
  resolveModelOverridePolicy: (...args: unknown[]) => ResolvedTtsModelOverrides;
  supportsNativeVoiceNoteTts: (channel: string | undefined) => boolean;
  summarizeText: (...args: unknown[]) => Promise<SummarizeResult>;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg?: OpenClawConfig,
  ) => SpeechProviderConfig;
  formatTtsProviderError: (provider: TtsProvider, err: unknown) => string;
  sanitizeTtsErrorForLog: (err: unknown) => string;
};

type FacadeModule = {
  _test: TtsTestFacade;
  buildTtsSystemPromptHint: (cfg: OpenClawConfig) => string | undefined;
  getLastTtsAttempt: () => TtsStatusEntry | undefined;
  getResolvedSpeechProviderConfig: (
    config: ResolvedTtsConfig,
    providerId: string,
    cfg?: OpenClawConfig,
  ) => SpeechProviderConfig;
  getTtsMaxLength: (prefsPath: string) => number;
  getTtsProvider: (config: ResolvedTtsConfig, prefsPath: string) => TtsProvider;
  isSummarizationEnabled: (prefsPath: string) => boolean;
  isTtsEnabled: (config: ResolvedTtsConfig, prefsPath: string, sessionAuto?: string) => boolean;
  isTtsProviderConfigured: (
    config: ResolvedTtsConfig,
    provider: TtsProvider,
    cfg?: OpenClawConfig,
  ) => boolean;
  listSpeechVoices: (params: ListSpeechVoicesParams) => Promise<SpeechVoiceOption[]>;
  maybeApplyTtsToPayload: (params: MaybeApplyTtsToPayloadParams) => Promise<ReplyPayload>;
  resolveExplicitTtsOverrides: (params: ResolveExplicitTtsOverridesParams) => TtsDirectiveOverrides;
  resolveTtsAutoMode: (params: ResolveTtsAutoModeParams) => TtsAutoMode;
  resolveTtsConfig: (cfg: OpenClawConfig) => ResolvedTtsConfig;
  resolveTtsPrefsPath: (config: ResolvedTtsConfig) => string;
  resolveTtsProviderOrder: (primary: TtsProvider, cfg?: OpenClawConfig) => TtsProvider[];
  setLastTtsAttempt: (entry: TtsStatusEntry | undefined) => void;
  setSummarizationEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsAutoMode: (prefsPath: string, mode: TtsAutoMode) => void;
  setTtsEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsMaxLength: (prefsPath: string, maxLength: number) => void;
  setTtsProvider: (prefsPath: string, provider: TtsProvider) => void;
  synthesizeSpeech: (params: TtsRequestParams) => Promise<TtsSynthesisResult>;
  textToSpeech: (params: TtsRequestParams) => Promise<TtsResult>;
  textToSpeechTelephony: (params: TtsTelephonyRequestParams) => Promise<TtsTelephonyResult>;
};

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "speech-core",
    artifactBasename: "runtime-api.js",
  });
}

export const _test: FacadeModule["_test"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()._test,
);
export const buildTtsSystemPromptHint: FacadeModule["buildTtsSystemPromptHint"] =
  createLazyFacadeValue("buildTtsSystemPromptHint");
export const getLastTtsAttempt: FacadeModule["getLastTtsAttempt"] =
  createLazyFacadeValue("getLastTtsAttempt");
export const getResolvedSpeechProviderConfig: FacadeModule["getResolvedSpeechProviderConfig"] =
  createLazyFacadeValue("getResolvedSpeechProviderConfig");
export const getTtsMaxLength: FacadeModule["getTtsMaxLength"] =
  createLazyFacadeValue("getTtsMaxLength");
export const getTtsProvider: FacadeModule["getTtsProvider"] =
  createLazyFacadeValue("getTtsProvider");
export const isSummarizationEnabled: FacadeModule["isSummarizationEnabled"] =
  createLazyFacadeValue("isSummarizationEnabled");
export const isTtsEnabled: FacadeModule["isTtsEnabled"] = createLazyFacadeValue("isTtsEnabled");
export const isTtsProviderConfigured: FacadeModule["isTtsProviderConfigured"] =
  createLazyFacadeValue("isTtsProviderConfigured");
export const listSpeechVoices: FacadeModule["listSpeechVoices"] =
  createLazyFacadeValue("listSpeechVoices");
export const maybeApplyTtsToPayload: FacadeModule["maybeApplyTtsToPayload"] =
  createLazyFacadeValue("maybeApplyTtsToPayload");
export const resolveExplicitTtsOverrides: FacadeModule["resolveExplicitTtsOverrides"] =
  createLazyFacadeValue("resolveExplicitTtsOverrides");
export const resolveTtsAutoMode: FacadeModule["resolveTtsAutoMode"] =
  createLazyFacadeValue("resolveTtsAutoMode");
export const resolveTtsConfig: FacadeModule["resolveTtsConfig"] =
  createLazyFacadeValue("resolveTtsConfig");
export const resolveTtsPrefsPath: FacadeModule["resolveTtsPrefsPath"] =
  createLazyFacadeValue("resolveTtsPrefsPath");
export const resolveTtsProviderOrder: FacadeModule["resolveTtsProviderOrder"] =
  createLazyFacadeValue("resolveTtsProviderOrder");
export const setLastTtsAttempt: FacadeModule["setLastTtsAttempt"] =
  createLazyFacadeValue("setLastTtsAttempt");
export const setSummarizationEnabled: FacadeModule["setSummarizationEnabled"] =
  createLazyFacadeValue("setSummarizationEnabled");
export const setTtsAutoMode: FacadeModule["setTtsAutoMode"] =
  createLazyFacadeValue("setTtsAutoMode");
export const setTtsEnabled: FacadeModule["setTtsEnabled"] = createLazyFacadeValue("setTtsEnabled");
export const setTtsMaxLength: FacadeModule["setTtsMaxLength"] =
  createLazyFacadeValue("setTtsMaxLength");
export const setTtsProvider: FacadeModule["setTtsProvider"] =
  createLazyFacadeValue("setTtsProvider");
export const synthesizeSpeech: FacadeModule["synthesizeSpeech"] =
  createLazyFacadeValue("synthesizeSpeech");
export const textToSpeech: FacadeModule["textToSpeech"] = createLazyFacadeValue("textToSpeech");
export const textToSpeechTelephony: FacadeModule["textToSpeechTelephony"] =
  createLazyFacadeValue("textToSpeechTelephony");

export type { ResolvedTtsConfig, ResolvedTtsModelOverrides };
export type { TtsDirectiveOverrides, TtsDirectiveParseResult };

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
};

export type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
};

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  sampleRate?: number;
};

function createLazyFacadeValue<K extends keyof FacadeModule>(key: K): FacadeModule[K] {
  return ((...args: unknown[]) => {
    const value = loadFacadeModule()[key];
    if (typeof value !== "function") {
      return value;
    }
    return (value as (...innerArgs: unknown[]) => unknown)(...args);
  }) as FacadeModule[K];
}
