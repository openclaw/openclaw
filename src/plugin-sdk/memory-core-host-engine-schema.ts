// Memory schema operations shared by host maintenance and native publication workers.
export {
  dropMemoryChunkFtsTriggers,
  dropMemoryPathFtsTriggers,
  ensureMemoryChunkProvenance,
  ensureMemoryChunkFtsTriggers,
  migrateMemoryIndexStorage,
  registerMemoryEmbeddingMigrationFunctions,
  markInvalidImportedMemoryEmbeddings,
  rebuildMemoryChunkFts,
  MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS,
  ensureMemoryIndexSchema,
  ensureMemoryPathFtsTriggers,
  ensureMemoryRecallMetadataSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
export {
  loadSqliteVecExtension,
  loadSqliteVecExtensionFromPath,
} from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
