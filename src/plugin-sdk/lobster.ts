// Narrow plugin-sdk surface for the bundled lobster plugin.
// Keep this list additive and scoped to symbols used under extensions/lobster.

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
