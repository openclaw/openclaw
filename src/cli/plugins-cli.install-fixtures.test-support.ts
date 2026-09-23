import type { OpenClawConfig } from "../config/types.openclaw.js";

export function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

export function createEmptyPluginConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {},
    },
  } as OpenClawConfig;
}
