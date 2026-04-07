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
  config: TConfig;
  enabled: boolean;
  reason?: string;
};

/**
 * Provider contract surfaces only ever enable provider plugins, so they do not
 * need the built-in channel normalization path from plugins/enable.ts.
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
