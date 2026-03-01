import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";

export type PluginEnableResult = {
  config: OpenClawConfig;
  enabled: boolean;
  reason?: string;
};

export function enablePluginInConfig(cfg: OpenClawConfig, pluginId: string): PluginEnableResult {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  const resolvedId = builtInChannelId ?? pluginId;
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, enabled: false, reason: "plugins disabled" };
  }
  if (cfg.plugins?.deny?.includes(pluginId) || cfg.plugins?.deny?.includes(resolvedId)) {
    return { config: cfg, enabled: false, reason: "blocked by denylist" };
  }
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const existing = channels?.[builtInChannelId];
    const existingRecord =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    let next: OpenClawConfig = {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...existingRecord,
          enabled: true,
        },
      },
    };
    next = ensurePluginAllowlisted(next, resolvedId);
    return { config: next, enabled: true };
  }

  const entries = {
    ...cfg.plugins?.entries,
    [resolvedId]: {
      ...(cfg.plugins?.entries?.[resolvedId] as Record<string, unknown> | undefined),
      enabled: true,
    },
  };
  let next: OpenClawConfig = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
  next = ensurePluginAllowlisted(next, resolvedId);
  return { config: next, enabled: true };
}
