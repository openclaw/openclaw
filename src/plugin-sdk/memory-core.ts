// Narrow plugin-sdk surface for the bundled memory-core plugin.
// Keep this list additive and scoped to the bundled memory-core surface.

export { getMemorySearchManager, MemoryIndexManager } from "./memory-core-engine-runtime.js";
export {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  emptyPluginConfigSchema,
  jsonResult,
  /**
   * @deprecated Use getRuntimeConfig(), runtime.config.current(), or pass the
   * already loaded config through the call path. Runtime code must not reload
   * config on demand. Bundled plugins and repo code are blocked from using
   * this by the deprecated-internal-config-api architecture guard.
   */
  loadConfig,
  parseAgentSessionKey,
  parseNonNegativeByteSize,
  readNumberParam,
  readStringParam,
  resolveCronStyleNow,
  resolveDefaultAgentId,
  resolveMemorySearchConfig,
  resolveSessionAgentId,
  resolveSessionTranscriptsDirForAgent,
  resolveStateDir,
  SILENT_REPLY_TOKEN,
} from "./memory-core-host-runtime-core.js";
export type {
  AnyAgentTool,
  MemoryCitationsMode,
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
  OpenClawConfig,
  OpenClawPluginApi,
} from "./memory-core-host-runtime-core.js";
export {
  colorize,
  defaultRuntime,
  formatDocsLink,
  formatErrorMessage,
  formatHelpExamples,
  isRich,
  isVerbose,
  resolveCommandSecretRefsViaGateway,
  setVerbose,
  shortenHomeInString,
  shortenHomePath,
  theme,
  withManager,
  withProgress,
  withProgressTotals,
} from "./memory-core-host-runtime-cli.js";
export {
  appendMemoryHostEvent,
  readMemoryHostEvents,
  resolveMemoryHostEventLogPath,
} from "./memory-core-host-events.js";
export type { MemoryHostEvent } from "./memory-core-host-events.js";
export {
  resolveMemoryCorePluginConfig,
  formatMemoryDreamingDay,
  isSameMemoryDreamingDay,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "./memory-core-host-status.js";
export {
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  readAgentMemoryFile,
  resolveMemoryBackendConfig,
} from "./memory-core-host-runtime-files.js";
export type { MemorySearchResult } from "./memory-core-host-runtime-files.js";
