import {
  createMemoryAddTool,
  createMemoryGetTool,
  createMemoryRelatedTool,
  createMemorySearchTool,
} from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createMemoryAddTool,
    createMemoryGetTool,
    createMemoryRelatedTool,
    createMemorySearchTool,
    registerMemoryCli,
  };
}
