import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { BUNDLED_WEB_FETCH_PLUGIN_IDS } from "./bundled-web-fetch-ids.js";
import { resolveBundledWebFetchPluginId as resolveBundledWebFetchPluginIdFromMap } from "./bundled-web-fetch-provider-ids.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry } from "./types.js";

type BundledWebFetchProviderEntry = PluginWebFetchProviderEntry & { pluginId: string };

let bundledWebFetchProvidersCache: BundledWebFetchProviderEntry[] | null = null;

function loadBundledWebFetchProviders(): BundledWebFetchProviderEntry[] {
  if (!bundledWebFetchProvidersCache) {
    bundledWebFetchProvidersCache = loadBundledCapabilityRuntimeRegistry({
      pluginIds: BUNDLED_WEB_FETCH_PLUGIN_IDS,
      pluginSdkResolution: "dist",
    }).webFetchProviders.map((entry) => ({
      pluginId: entry.pluginId,
      ...entry.provider,
    }));
  }
  return bundledWebFetchProvidersCache;
}

export function resolveBundledWebFetchPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const bundledWebFetchPluginIdSet = new Set<string>(BUNDLED_WEB_FETCH_PLUGIN_IDS);
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) => plugin.origin === "bundled" && bundledWebFetchPluginIdSet.has(plugin.id),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledWebFetchProviders(): PluginWebFetchProviderEntry[] {
  return loadBundledWebFetchProviders();
}

export function resolveBundledWebFetchPluginId(providerId: string | undefined): string | undefined {
  return resolveBundledWebFetchPluginIdFromMap(providerId);
}
