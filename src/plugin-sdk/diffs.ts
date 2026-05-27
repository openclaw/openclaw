// Narrow plugin-sdk surface for the bundled diffs plugin.
// Keep this list additive and scoped to the bundled diffs surface.

export { definePluginEntry } from "./plugin-entry.js";
export type { OpenClawConfig } from "../config/config.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginToolContext,
  PluginLogger,
} from "../plugins/types.js";
