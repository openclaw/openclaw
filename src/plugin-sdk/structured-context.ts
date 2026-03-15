// Narrow plugin-sdk surface for the bundled structured-context plugin.
// Keep this list additive and scoped to symbols used under extensions/structured-context.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { OpenClawPluginApi, OpenClawPluginConfigSchema } from "../plugins/types.js";
export type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
} from "../context-engine/types.js";
