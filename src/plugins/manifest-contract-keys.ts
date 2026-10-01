// Parsing, catalog overlays, and capability consent account for the same families.
export const PLUGIN_MANIFEST_CONTRACT_KEYS = [
  /** Executor ids implemented by the plugin's code-mode-executor-api artifact. */
  "codeModeExecutors",
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  /** Provider ids whose runtime-only auth hooks let overlays load only the owning plugin. */
  "externalAuthProviders",
  "decisionProviders",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  /** Provider ids whose plugin owns usage auth and snapshot hooks. */
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const;
