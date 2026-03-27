// Narrow engine surface for the bundled memory-core plugin.
// Keep this limited to host utilities needed by the memory engine cluster.

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
export { parseDurationMs } from "../cli/parse-duration.js";
export { loadConfig } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "../config/types.secrets.js";
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
} from "../plugins/memory-host/internal.js";
export { readMemoryFile } from "../plugins/memory-host/read-file.js";
export { resolveMemoryBackendConfig } from "../plugins/memory-host/backend-config.js";
export type {
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "../plugins/memory-host/backend-config.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "../plugins/memory-host/types.js";
export {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
} from "../plugins/memory-embedding-providers.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../plugins/memory-embedding-providers.js";
export {
  createLocalEmbeddingProvider,
  createEmbeddingProvider,
  DEFAULT_LOCAL_MODEL,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "../plugins/memory-host/embeddings.js";
export {
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  buildGeminiEmbeddingRequest,
} from "../plugins/memory-host/embeddings-gemini.js";
export {
  createMistralEmbeddingProvider,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
} from "../plugins/memory-host/embeddings-mistral.js";
export {
  createOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
} from "../plugins/memory-host/embeddings-ollama.js";
export {
  createOpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from "../plugins/memory-host/embeddings-openai.js";
export {
  createVoyageEmbeddingProvider,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
} from "../plugins/memory-host/embeddings-voyage.js";
export {
  runGeminiEmbeddingBatches,
  type GeminiBatchRequest,
} from "../plugins/memory-host/batch-gemini.js";
export {
  OPENAI_BATCH_ENDPOINT,
  runOpenAiEmbeddingBatches,
  type OpenAiBatchRequest,
} from "../plugins/memory-host/batch-openai.js";
export {
  runVoyageEmbeddingBatches,
  type VoyageBatchRequest,
} from "../plugins/memory-host/batch-voyage.js";
export { enforceEmbeddingMaxInputTokens } from "../plugins/memory-host/embedding-chunk-limits.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "../plugins/memory-host/embedding-input-limits.js";
export {
  hasNonTextEmbeddingParts,
  type EmbeddingInput,
} from "../plugins/memory-host/embedding-inputs.js";
export {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "../plugins/memory-host/multimodal.js";
export { ensureMemoryIndexSchema } from "../plugins/memory-host/memory-schema.js";
export { loadSqliteVecExtension } from "../plugins/memory-host/sqlite-vec.js";
export { requireNodeSqlite } from "../plugins/memory-host/sqlite.js";
export { extractKeywords, isQueryStopWordToken } from "../plugins/memory-host/query-expansion.js";
export {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
  type SessionFileEntry,
} from "../plugins/memory-host/session-files.js";
export { parseQmdQueryJson, type QmdQueryResult } from "../plugins/memory-host/qmd-query-parser.js";
export {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
} from "../plugins/memory-host/qmd-scope.js";
export { isFileMissingError, statRegularFile } from "../plugins/memory-host/fs-utils.js";
export { resolveCliSpawnInvocation, runCliCommand } from "../plugins/memory-host/qmd-process.js";
export { detectMime } from "../media/mime.js";
export { splitShellArgs } from "../utils/shell-argv.js";
export { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
export {
  shortenHomeInString,
  shortenHomePath,
  resolveUserPath,
  truncateUtf16Safe,
} from "../utils.js";
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
export type { MemorySearchConfig } from "../config/types.tools.js";
export type { SecretInput } from "../config/types.secrets.js";
