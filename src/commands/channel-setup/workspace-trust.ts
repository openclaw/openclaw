import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizePluginsConfig, resolveEnableState } from "../../plugins/config-state.js";
import type { PluginOrigin } from "../../plugins/types.js";

export function isTrustedWorkspacePlugin(params: {
  pluginId: string | undefined;
  origin: PluginOrigin | undefined;
  cfg: OpenClawConfig;
}): boolean {
  if (params.origin !== "workspace") {
    return true;
  }
  if (!params.pluginId) {
    return false;
  }
  return resolveEnableState(
    params.pluginId,
    "workspace",
    normalizePluginsConfig(params.cfg.plugins),
  ).enabled;
}

export function isTrustedWorkspaceChannelCatalogEntry(
  entry: ChannelPluginCatalogEntry | undefined,
  cfg: OpenClawConfig,
): boolean {
  return isTrustedWorkspacePlugin({
    pluginId: entry?.pluginId,
    origin: entry?.origin,
    cfg,
  });
}
