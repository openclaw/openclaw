// Narrow plugin-sdk surface for the bundled memory-core plugin.
// Keep this list additive and scoped to the bundled memory-core surface.

export { getMemorySearchManager, MemoryIndexManager } from "./memory-core-engine-runtime.js";
export {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  emptyPluginConfigSchema,
  jsonResult,
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
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  readAgentMemoryFile,
  resolveMemoryBackendConfig,
} from "./memory-core-host-runtime-files.js";
export type { MemorySearchResult } from "./memory-core-host-runtime-files.js";
