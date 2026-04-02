import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveBundledWebFetchPluginIds } from "./bundled-web-fetch.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry } from "./types.js";

function resolveBundledWebFetchCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveBundledWebFetchPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

function compareWebFetchProvidersAlphabetically(
  left: Pick<PluginWebFetchProviderEntry, "id" | "pluginId">,
  right: Pick<PluginWebFetchProviderEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortWebFetchProviders(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return providers.toSorted(compareWebFetchProvidersAlphabetically);
}

export function sortWebFetchProvidersForAutoDetect(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return compareWebFetchProvidersAlphabetically(left, right);
  });
}

export function resolveBundledWebFetchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  normalized: NormalizedPluginsConfig;
} {
  const autoEnabledConfig =
    params.config !== undefined
      ? applyPluginAutoEnable({
          config: params.config,
          env: params.env ?? process.env,
        }).config
      : undefined;
  const bundledCompatPluginIds = resolveBundledWebFetchCompatPluginIds({
    config: autoEnabledConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: autoEnabledConfig,
        pluginIds: bundledCompatPluginIds,
      })
    : autoEnabledConfig;
  const enablementCompat = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: bundledCompatPluginIds,
  });
  const config = withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds: bundledCompatPluginIds,
    env: params.env,
  });

  return {
    config,
    normalized: normalizePluginsConfig(config?.plugins),
  };
}
