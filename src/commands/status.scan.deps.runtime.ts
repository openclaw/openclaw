// Runtime dependency adapters for status scans.
// Keeps plugin/runtime modules outside the core scan files until a caller needs them.

export { getTailnetHostname } from "../infra/tailscale.js";
export { getActiveMemorySearchManagerCore as getMemorySearchManager } from "../plugins/memory-runtime.js";
