import { cloneConfigWithResolutionFacts } from "../../config/resolution-facts.js";
import { readRuntimeConfig } from "../../config/runtime-snapshot.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    current: (options?: { clone: true }) => {
      const config = readRuntimeConfig();
      return options?.clone ? cloneConfigWithResolutionFacts(config) : config;
    },
    mutateConfigFile: async (params) => {
      const { mutateConfigFile } = await import("../../config/mutate.js");
      return await mutateConfigFile(params);
    },
    replaceConfigFile: async (params) => {
      const { replaceConfigFile } = await import("../../config/mutate.js");
      return await replaceConfigFile(params);
    },
  };
}
