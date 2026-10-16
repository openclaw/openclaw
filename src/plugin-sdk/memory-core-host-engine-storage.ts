/**
 * Private runtime facade for memory host storage, indexing, and search primitives.
 */
export { encodeSqliteStringSet, sqliteStringSetEntries } from "../infra/kysely-sync.js";
export {
  loadSqliteVecExtension,
  loadSqliteVecExtensionFromPath,
} from "../infra/database-engine/sqlite-vec.js";
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
  readMemorySearchManagerStatus,
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
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { chunkMarkdown } from "../../packages/memory-host-sdk/src/engine-storage.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { ensureDir } from "../../packages/memory-host-sdk/src/engine-storage.js";

export type {
  MemoryWorkspaceFiles,
  MemoryWorkspaceWatchRequest,
  MemoryEntryProvenance,
  MemoryExtraPath,
  MemorySearchResult,
  MemorySource,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

export { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
export { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
export { DatabaseSearchCapabilityUnavailableError } from "../infra/database-engine/capability-unavailable.js";

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
