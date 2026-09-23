// External Groq fixtures consume native SDK exports from the current test generation.
const currentModuleUrl = import.meta.url;
export const groqSetupSdkEntrypoints = [
  {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/provider-entry",
    distWorkerPath: "plugin-sdk/provider-entry.js",
  },
  {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/provider-model-metadata",
    distWorkerPath: "plugin-sdk/provider-model-metadata.js",
  },
] as const;
