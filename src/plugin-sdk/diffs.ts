// Narrow plugin-sdk surface for the bundled diffs plugin.
// Keep this list additive and scoped to the bundled diffs surface.

export { definePluginEntry } from "./plugin-entry.js";
export type { MullusiConfig } from "../config/config.js";
export { resolvePreferredMullusiTmpDir } from "../infra/tmp-mullusi-dir.js";
export type {
  AnyAgentTool,
  MullusiPluginApi,
  MullusiPluginConfigSchema,
  MullusiPluginToolContext,
  PluginLogger,
} from "../plugins/types.js";
