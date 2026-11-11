// Filesystem workers must not load the memory index, database, or embedding runtime.
export { root } from "../infra/fs-safe.js";
export { resolveUserPath } from "../utils.js";
export {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
} from "../../packages/memory-host-sdk/src/host/internal.js";
export { classifyMemoryMultimodalPath } from "../../packages/memory-host-sdk/src/host/multimodal.js";
export { readMemoryFile } from "../../packages/memory-host-sdk/src/host/read-file.js";
