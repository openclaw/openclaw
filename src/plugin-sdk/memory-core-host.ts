// Narrow helper surface for the bundled memory-core plugin implementation.
// Keep this focused on generic host seams and shared utilities.

export type { AnyAgentTool } from "../agents/tools/common.js";
export { resolveCronStyleNow } from "../agents/current-time.js";
export { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../agents/pi-settings.js";
export {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
export {
  resolveMemorySearchConfig,
  type ResolvedMemorySearchConfig,
} from "../agents/memory-search.js";
export { jsonResult, readNumberParam, readStringParam } from "../agents/tools/common.js";
export { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { formatErrorMessage, withManager } from "../cli/cli-utils.js";
export { formatHelpExamples } from "../cli/help-format.js";
export { parseDurationMs } from "../cli/parse-duration.js";
export { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
export { withProgress, withProgressTotals } from "../cli/progress.js";
export { parseNonNegativeByteSize } from "../config/byte-size.js";
export { loadConfig } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
export { writeFileWithinRoot } from "../infra/fs-safe.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { resolveGlobalSingleton } from "../shared/global-singleton.js";
export { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  cosineSimilarity,
  ensureDir,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  remapChunkLines,
  runWithConcurrency,
  type MemoryChunk,
  type MemoryFileEntry,
} from "../memory/internal.js";
export { readAgentMemoryFile, readMemoryFile } from "../memory/read-file.js";
export { resolveMemoryBackendConfig } from "../memory/backend-config.js";
export type {
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "../memory/backend-config.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "../memory/types.js";
export {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "../memory/embeddings.js";
export {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  buildGeminiEmbeddingRequest,
} from "../memory/embeddings-gemini.js";
export { DEFAULT_MISTRAL_EMBEDDING_MODEL } from "../memory/embeddings-mistral.js";
export { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "../memory/embeddings-ollama.js";
export { DEFAULT_OPENAI_EMBEDDING_MODEL } from "../memory/embeddings-openai.js";
export { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "../memory/embeddings-voyage.js";
export { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "../memory/batch-gemini.js";
export {
  OPENAI_BATCH_ENDPOINT,
  runOpenAiEmbeddingBatches,
  type OpenAiBatchRequest,
} from "../memory/batch-openai.js";
export { runVoyageEmbeddingBatches, type VoyageBatchRequest } from "../memory/batch-voyage.js";
export { enforceEmbeddingMaxInputTokens } from "../memory/embedding-chunk-limits.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "../memory/embedding-input-limits.js";
export { hasNonTextEmbeddingParts, type EmbeddingInput } from "../memory/embedding-inputs.js";
export {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "../memory/multimodal.js";
export { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
export { loadSqliteVecExtension } from "../memory/sqlite-vec.js";
export { requireNodeSqlite } from "../memory/sqlite.js";
export { extractKeywords, isQueryStopWordToken } from "../memory/query-expansion.js";
export {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
  type SessionFileEntry,
} from "../memory/session-files.js";
export { parseQmdQueryJson, type QmdQueryResult } from "../memory/qmd-query-parser.js";
export {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
} from "../memory/qmd-scope.js";
export { isFileMissingError, statRegularFile } from "../memory/fs-utils.js";
export { resolveCliSpawnInvocation, runCliCommand } from "../memory/qmd-process.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "../config/types.secrets.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { parseAgentSessionKey } from "../routing/session-key.js";
export { defaultRuntime } from "../runtime.js";
export { colorize, isRich, theme } from "../terminal/theme.js";
export { formatDocsLink } from "../terminal/links.js";
export { detectMime } from "../media/mime.js";
export { setVerbose, isVerbose } from "../globals.js";
export {
  shortenHomeInString,
  shortenHomePath,
  resolveUserPath,
  truncateUtf16Safe,
} from "../utils.js";
export { splitShellArgs } from "../utils/shell-argv.js";
export { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SessionSendPolicyConfig } from "../config/types.base.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "../config/types.memory.js";
export type { SecretInput } from "../config/types.secrets.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "../plugins/memory-state.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
