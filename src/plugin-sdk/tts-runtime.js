import { createLazyFacadeValue as createLazyFacadeRuntimeValue, createLazyFacadeObjectValue, loadActivatedBundledPluginPublicSurfaceModuleSync, } from "./facade-runtime.js";
function loadFacadeModule() {
    return loadActivatedBundledPluginPublicSurfaceModuleSync({
        dirName: "speech-core",
        artifactBasename: "runtime-api.js",
    });
}
export const _test = createLazyFacadeObjectValue(() => loadFacadeModule()._test);
export const buildTtsSystemPromptHint = createLazyFacadeRuntimeValue(loadFacadeModule, "buildTtsSystemPromptHint");
export const getLastTtsAttempt = createLazyFacadeRuntimeValue(loadFacadeModule, "getLastTtsAttempt");
export const getResolvedSpeechProviderConfig = createLazyFacadeRuntimeValue(loadFacadeModule, "getResolvedSpeechProviderConfig");
export const getTtsMaxLength = createLazyFacadeRuntimeValue(loadFacadeModule, "getTtsMaxLength");
export const getTtsProvider = createLazyFacadeRuntimeValue(loadFacadeModule, "getTtsProvider");
export const isSummarizationEnabled = createLazyFacadeRuntimeValue(loadFacadeModule, "isSummarizationEnabled");
export const isTtsEnabled = createLazyFacadeRuntimeValue(loadFacadeModule, "isTtsEnabled");
export const isTtsProviderConfigured = createLazyFacadeRuntimeValue(loadFacadeModule, "isTtsProviderConfigured");
export const listSpeechVoices = createLazyFacadeRuntimeValue(loadFacadeModule, "listSpeechVoices");
export const maybeApplyTtsToPayload = createLazyFacadeRuntimeValue(loadFacadeModule, "maybeApplyTtsToPayload");
export const resolveExplicitTtsOverrides = createLazyFacadeRuntimeValue(loadFacadeModule, "resolveExplicitTtsOverrides");
export const resolveTtsAutoMode = createLazyFacadeRuntimeValue(loadFacadeModule, "resolveTtsAutoMode");
export const resolveTtsConfig = createLazyFacadeRuntimeValue(loadFacadeModule, "resolveTtsConfig");
export const resolveTtsPrefsPath = createLazyFacadeRuntimeValue(loadFacadeModule, "resolveTtsPrefsPath");
export const resolveTtsProviderOrder = createLazyFacadeRuntimeValue(loadFacadeModule, "resolveTtsProviderOrder");
export const setLastTtsAttempt = createLazyFacadeRuntimeValue(loadFacadeModule, "setLastTtsAttempt");
export const setSummarizationEnabled = createLazyFacadeRuntimeValue(loadFacadeModule, "setSummarizationEnabled");
export const setTtsAutoMode = createLazyFacadeRuntimeValue(loadFacadeModule, "setTtsAutoMode");
export const setTtsEnabled = createLazyFacadeRuntimeValue(loadFacadeModule, "setTtsEnabled");
export const setTtsMaxLength = createLazyFacadeRuntimeValue(loadFacadeModule, "setTtsMaxLength");
export const setTtsProvider = createLazyFacadeRuntimeValue(loadFacadeModule, "setTtsProvider");
export const synthesizeSpeech = createLazyFacadeRuntimeValue(loadFacadeModule, "synthesizeSpeech");
export const textToSpeech = createLazyFacadeRuntimeValue(loadFacadeModule, "textToSpeech");
export const textToSpeechTelephony = createLazyFacadeRuntimeValue(loadFacadeModule, "textToSpeechTelephony");
