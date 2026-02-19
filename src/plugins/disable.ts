import type { OpenClawConfig } from "../config/config.js";

export type PluginDisableResult = {
  config: OpenClawConfig;
  disabled: boolean;
  reason?: string;
};

export function disablePluginInConfig(cfg: OpenClawConfig, pluginId: string): PluginDisableResult {
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, disabled: true, reason: "plugins already disabled" };
  }

  const entries = {
    ...cfg.plugins?.entries,
    [pluginId]: {
      ...(cfg.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
      enabled: false,
    },
  };

  return {
    config: {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        entries,
      },
    },
    disabled: true,
  };
}
