// Narrow plugin-sdk surface for the bundled diffs plugin.
// Keep this list additive and scoped to symbols used under extensions/diffs.

export { definePluginEntry } from "./core.js";
export type { OpenClawConfig } from "../config/config.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginToolContext,
  PluginLogger,
} from "../plugins/types.js";
