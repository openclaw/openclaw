// Narrow plugin-sdk surface for the bundled memory-lancedb plugin.
// Keep this list additive and scoped to the bundled memory-lancedb surface.

export { definePluginEntry } from "./plugin-entry.js";
export { resolveStateDir } from "./state-paths.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
