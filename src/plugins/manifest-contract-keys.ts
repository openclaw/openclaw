// Parsing, catalog overlays, and capability consent account for the same families.
export const PLUGIN_MANIFEST_CONTRACT_KEYS = [
  /** Executor ids implemented by the plugin's code-mode-executor-api artifact. */
  "codeModeExecutors",
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
  /** Worker provider ids offering config suggestions through worker-profile-api. */
  "workerProfileSuggestions",
  "storageProviders",
  /** Provider ids whose plugin owns usage auth and snapshot hooks. */
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  /** Invocation-scoped command runtime families, reviewed before loading plugin code. */
  "commandRuntimeCapabilities",
  /** Native, bounded, requester-admitted scheduled command turns. */
  "sessionScheduledTurns",
  "tools",
] as const;

/** Static transcript setup metadata; runtime registration does not gate configuration. */
export const TRANSCRIPT_SOURCE_LOCATOR_FIELDS = [
  "accountId",
  "guildId",
  "channelId",
  "meetingUrl",
] as const;
