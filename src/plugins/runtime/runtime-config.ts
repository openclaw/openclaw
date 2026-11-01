import { getRuntimeConfig } from "../../config/io.runtime.js";
import { cloneConfigWithResolutionFacts } from "../../config/resolution-facts.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    current: (options?: { clone: true }) => {
      const config = getRuntimeConfig();
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
