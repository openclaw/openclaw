// Public Lobster plugin helpers.
// Keep this surface narrow and limited to the Lobster workflow/tool contract.

export { definePluginEntry } from "./core.js";
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
