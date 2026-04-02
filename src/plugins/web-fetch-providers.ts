import { listBundledWebFetchProviders as listBundledWebFetchProviderEntries } from "./bundled-web-fetch.js";
import { resolveEffectiveEnableState } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledWebFetchResolutionConfig,
  sortWebFetchProviders,
} from "./web-fetch-providers.shared.js";

function listBundledWebFetchProviders(): PluginWebFetchProviderEntry[] {
  return sortWebFetchProviders(listBundledWebFetchProviderEntries());
}

export function resolveBundledPluginWebFetchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): PluginWebFetchProviderEntry[] {
  const { config, normalized } = resolveBundledWebFetchResolutionConfig(params);
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;

  return listBundledWebFetchProviders().filter((provider) => {
    if (onlyPluginIdSet && !onlyPluginIdSet.has(provider.pluginId)) {
      return false;
    }
    return resolveEffectiveEnableState({
      id: provider.pluginId,
      origin: "bundled",
      config: normalized,
      rootConfig: config,
    }).enabled;
  });
}
