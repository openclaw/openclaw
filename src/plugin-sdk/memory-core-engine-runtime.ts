// Thin engine runtime compat surface for the bundled memory-core plugin.
// Keep extension-owned engine exports isolated behind a dedicated SDK subpath.

export {
  getMemorySearchManager,
  MemoryIndexManager,
} from "../../extensions/memory-core/src/memory/index.js";
