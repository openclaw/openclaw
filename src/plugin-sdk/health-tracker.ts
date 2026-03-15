// Narrow plugin-sdk surface for the bundled health-tracker plugin.
// Keep this list additive and scoped to symbols used under extensions/health-tracker.

export { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";
export { STATE_DIR } from "../config/paths.js";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "../plugins/types.js";
