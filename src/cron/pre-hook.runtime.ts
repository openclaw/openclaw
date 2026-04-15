// Runtime seam for lazy imports of pre-hook execution.
// Production callers dynamically import this boundary instead of pre-hook.ts
// directly, so tests can mock the seam without paying the full module cost.
export { runPreHook } from "./pre-hook.js";
