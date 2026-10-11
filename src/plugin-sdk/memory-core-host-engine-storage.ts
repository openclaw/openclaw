/**
 * Private runtime facade for memory host storage, indexing, and search primitives.
 */
export { encodeSqliteStringSet, sqliteStringSetEntries } from "../infra/kysely-sync.js";
export {
  ensureMemoryEntryOriginsSchema,
  readMemoryEntryOriginsInDatabase,
  recordMemoryEntryOriginsInDatabase,
  type MemoryEntryOrigin,
} from "../../packages/memory-host-sdk/src/memory-entry-origins.js";

export {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  encodeMemoryEmbedding,
  decodeMemoryEmbedding,
  createMemorySearchDeadlineControl,
  ensureMemoryChunkProvenance,
  ensureMemoryIndexSchema,
  hashText,
  INVALID_PROJECT_ANNOTATION_KEY,
  isAutomaticMemoryEntryEligible,
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
  loadSqliteVecExtensionFromPath,
  matchesExtraMemoryPathEntry,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  MEMORY_CHUNKING_VERSION,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_DERIVED_TABLES,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  normalizeExtraMemoryPathEntries,
  readMemoryFile,
  readCuratedProjectMemoryCandidates,
  readCuratedMemoryTriggerCandidates,
  readMemoryRecallMetadata,
  retryTransientMemoryRead,
  requireNodeSqlite,
  formatMemoryIndexRebuildGuidance,
  resolveMemoryIndexIdentityDiagnostic,
  resolveMemoryIndexSearchDiagnostic,
  resolveMemorySearchStaleness,
  runWithConcurrency,
  stopMemorySqliteWalMaintenance,
  stripMemoryAnnotationCarriers,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

export type {
  MemoryWorkspaceFiles,
  MemoryWorkspaceWatchRequest,
  MemoryEntryProvenance,
  MemoryExtraPath,
  MemorySearchResult,
  MemorySource,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

export { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";

/** Health probe result for embedding provider availability checks. */
export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

export type {
  MemoryCliSearchParams,
  MemoryCliSearchResult,
  MemoryCliSearchOutcome,
  MemoryChunk,
  MemoryFileEntry,
  MemoryIndexIdentityDiagnostic,
  MemoryIndexIdentityState,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchDeadlineControl,
  MemorySearchDeadlineControlOptions,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySyncProgressUpdate,
  MemorySessionSyncTarget,
  MemorySyncParams,
  MemoryVectorIndexState,
} from "../../packages/memory-host-sdk/src/engine-storage.js";
