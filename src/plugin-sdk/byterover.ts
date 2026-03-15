// Narrow plugin-sdk surface for the bundled byterover context engine plugin.
// Keep this list additive and scoped to symbols used under extensions/byterover.

export type { OpenClawPluginApi, PluginLogger } from "../plugins/types.js";
export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "../context-engine/types.js";
