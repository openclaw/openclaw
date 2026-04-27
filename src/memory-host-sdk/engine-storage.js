// Real workspace contract for memory engine storage/index helpers.
export { buildFileEntry, buildMultimodalChunkForIndexing, chunkMarkdown, cosineSimilarity, ensureDir, hashText, listMemoryFiles, normalizeExtraMemoryPaths, parseEmbedding, remapChunkLines, runWithConcurrency, } from "./host/internal.js";
export { readMemoryFile } from "./host/read-file.js";
export { buildMemoryReadResult, buildMemoryReadResultFromSlice, DEFAULT_MEMORY_READ_LINES, DEFAULT_MEMORY_READ_MAX_CHARS, } from "./host/read-file-shared.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export { ensureMemoryIndexSchema } from "./host/memory-schema.js";
export { loadSqliteVecExtension } from "./host/sqlite-vec.js";
export { requireNodeSqlite } from "./host/sqlite.js";
export { isFileMissingError, statRegularFile } from "./host/fs-utils.js";
