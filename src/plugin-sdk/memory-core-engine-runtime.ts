// Thin engine runtime compat surface for the bundled memory-core plugin.
// Keep extension-owned engine exports isolated behind a dedicated SDK subpath.

export {
  getBuiltinMemoryEmbeddingProviderDoctorMetadata,
  getMemorySearchManager,
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata,
  MemoryIndexManager,
} from "../../extensions/memory-core/runtime-api.js";
export type { BuiltinMemoryEmbeddingProviderDoctorMetadata } from "../../extensions/memory-core/runtime-api.js";
