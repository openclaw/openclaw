import type { PluginRuntime } from "./types.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    loadConfig,
    writeConfigFile,
  };
}
