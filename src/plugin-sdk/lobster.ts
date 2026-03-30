// Private plugin helpers for bundled extensions (workflow/tool contract).
// Keep this surface narrow and limited to the workflow/tool contract.

export { definePluginEntry } from "./plugin-entry.js";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "./windows-spawn.js";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "../plugins/types.js";
