import type { PluginRuntime } from "./types.js";
import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";

export function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createMemoryGetTool,
    createMemorySearchTool,
    registerMemoryCli,
  };
}
