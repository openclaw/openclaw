// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/speech-core/runtime-api.js");
import {
  createLazyFacadeObjectValue,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

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

export type ResolvedTtsConfig = import("@openclaw/speech-core/runtime-api.js").ResolvedTtsConfig;
export type ResolvedTtsModelOverrides =
  import("@openclaw/speech-core/runtime-api.js").ResolvedTtsModelOverrides;
export type TtsDirectiveOverrides =
  import("@openclaw/speech-core/runtime-api.js").TtsDirectiveOverrides;
export type TtsDirectiveParseResult =
  import("@openclaw/speech-core/runtime-api.js").TtsDirectiveParseResult;
export type TtsResult = import("@openclaw/speech-core/runtime-api.js").TtsResult;
export type TtsSynthesisResult = import("@openclaw/speech-core/runtime-api.js").TtsSynthesisResult;
export type TtsTelephonyResult = import("@openclaw/speech-core/runtime-api.js").TtsTelephonyResult;

function createLazyFacadeValue<K extends keyof FacadeModule>(key: K): FacadeModule[K] {
  return ((...args: unknown[]) => {
    const value = loadFacadeModule()[key];
    if (typeof value !== "function") {
      return value;
    }
    return (value as (...innerArgs: unknown[]) => unknown)(...args);
  }) as FacadeModule[K];
}
