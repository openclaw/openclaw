/**
 * Lazy-loading boundary for memory prefetch.
 * Re-exports getMemorySearchManager so agent-runner-memory.ts can dynamic-import
 * this file without triggering [INEFFECTIVE_DYNAMIC_IMPORT] for memory/index.ts.
 */
export { getMemorySearchManager } from "./index.js";
