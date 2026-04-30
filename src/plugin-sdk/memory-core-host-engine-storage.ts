export {
  buildFileEntry,
  buildMemoryReadResult,
  buildMemoryReadResultFromSlice,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  cosineSimilarity,
  DEFAULT_MEMORY_READ_LINES,
  DEFAULT_MEMORY_READ_MAX_CHARS,
  ensureDir,
  ensureMemoryIndexSchema,
  hashText,
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  readMemoryFile,
  remapChunkLines,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
  runWithConcurrency,
  statRegularFile,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

export type MemorySource = "memory" | "sessions";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
  /**
   * True when the probe was bounded by a diagnostic budget at the call site
   * and did not complete in time. Distinct from a hard provider failure: a
   * timed-out probe means the embedding backend may still be initializing or
   * is unreachable, but indexing/search may succeed once the provider warms
   * up. CLI surfaces should render this as "timeout" rather than "unavailable".
   */
  timedOut?: boolean;
};

export type {
  MemoryChunk,
  MemoryFileEntry,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySyncProgressUpdate,
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "../../packages/memory-host-sdk/src/engine-storage.js";
