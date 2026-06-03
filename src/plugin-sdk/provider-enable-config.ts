import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";

type ProviderPluginConfig = {
  enabled?: boolean;
};

type ProviderEnableConfigCarrier = {
  plugins?: {
    enabled?: boolean;
    deny?: string[];
    allow?: string[];
    entries?: Record<string, ProviderPluginConfig | undefined>;
  };
};

export type PluginEnableResult<TConfig extends ProviderEnableConfigCarrier> = {
  /** Config object to persist after the enable attempt. Unchanged when policy blocks the plugin. */
  config: TConfig;
  /** Whether the plugin was enabled and allowlisted. */
  enabled: boolean;
  /** Human-readable policy reason when the plugin cannot be enabled. */
  reason?: string;
};

/**
 * Enables provider plugins for provider contract setup without applying channel
 * normalization from the core plugin enable path.
 */
export function enablePluginInConfig<TConfig extends ProviderEnableConfigCarrier>(
  cfg: TConfig,
  pluginId: string,
): PluginEnableResult<TConfig> {
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, enabled: false, reason: "plugins disabled" };
  }
  if (cfg.plugins?.deny?.includes(pluginId)) {
    return { config: cfg, enabled: false, reason: "blocked by denylist" };
  }

  let next = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [pluginId]: {
          ...(cfg.plugins?.entries?.[pluginId] as object | undefined),
          enabled: true,
        },
      },
    },
  } as TConfig;
  next = ensurePluginAllowlisted(next, pluginId);
  return { config: next, enabled: true };
}
