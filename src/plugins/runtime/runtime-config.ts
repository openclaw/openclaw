import * as configRuntime from "../../config/config.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    loadConfig: configRuntime.loadConfig,
    writeConfigFile:
      typeof configRuntime.writeConfigFile === "function"
        ? configRuntime.writeConfigFile
        : async () => {
            throw new Error("writeConfigFile is unavailable in the current runtime");
          },
  };
}
