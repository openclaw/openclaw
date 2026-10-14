import type { PluginRuntime } from "./runtime/types.js";

/** One namespace projection belongs to its runtime source, not the invocation reading it. */
function createRuntimeFacade<T extends { [K in keyof T]: (...args: never[]) => unknown }>(
  invoke: <TResult>(run: () => TResult) => TResult,
  methods: readonly (keyof T)[],
) {
  let cached: { source: T; value: T } | undefined;
  return (source: T): T => {
    if (cached && cached.source === source) {
      return cached.value;
    }
    const value = { ...source };
    for (const method of methods) {
      Object.defineProperty(value, method, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (...args: unknown[]) => invoke(() => Reflect.apply(source[method], source, args)),
      });
    }
    cached = { source, value };
    return value;
  };
}

export function createPluginRuntimeFacades(invokeSelectedRuntime: <T>(run: () => T) => T) {
  return {
    media: createRuntimeFacade<PluginRuntime["media"]>(invokeSelectedRuntime, ["loadWebMedia"]),
    imageGeneration: createRuntimeFacade<PluginRuntime["imageGeneration"]>(invokeSelectedRuntime, [
      "generate",
      "listProviders",
    ]),
    videoGeneration: createRuntimeFacade<PluginRuntime["videoGeneration"]>(invokeSelectedRuntime, [
      "generate",
      "listProviders",
    ]),
    musicGeneration: createRuntimeFacade<PluginRuntime["musicGeneration"]>(invokeSelectedRuntime, [
      "generate",
      "listProviders",
    ]),
    webSearch: createRuntimeFacade<PluginRuntime["webSearch"]>(invokeSelectedRuntime, [
      "listProviders",
      "listProvidersAsync",
      "search",
    ]),
    tts: createRuntimeFacade<PluginRuntime["tts"]>(invokeSelectedRuntime, [
      "prepareTtsRequest",
      "textToSpeech",
      "textToSpeechStream",
      "textToSpeechTelephony",
      "listVoices",
    ]),
    mediaUnderstanding: createRuntimeFacade<PluginRuntime["mediaUnderstanding"]>(
      invokeSelectedRuntime,
      [
        "resolveAudioInputBudget",
        "runFile",
        "describeImageFile",
        "describeImageFileWithModel",
        "extractStructuredWithModel",
        "describeVideoFile",
        "transcribeAudioFile",
      ],
    ),
    modelAuth: createRuntimeFacade<PluginRuntime["modelAuth"]>(invokeSelectedRuntime, [
      "ensureAuthProfileStore",
      "ensureAuthProfileStoreAsync",
      "isProviderApiKeyConfigured",
      "isProviderApiKeyConfiguredAsync",
      "getApiKeyForModel",
      "getRuntimeAuthForModel",
      "resolveApiKeyForProvider",
    ]),
    modelConfig: createRuntimeFacade<PluginRuntime["modelConfig"]>(invokeSelectedRuntime, [
      "resolveDefaultModelForAgent",
      "resolveAllowedModelRef",
    ]),
    sandbox: createRuntimeFacade<PluginRuntime["sandbox"]>(invokeSelectedRuntime, [
      "resolveWorkspaceAuthority",
      "prepareWorkspaceAuthority",
    ]),
  };
}
