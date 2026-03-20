import { bundledWebSearchPluginRegistrations } from "./bundled-web-search-registry.js";
import { capturePluginRegistration } from "./captured-registration.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = bundledWebSearchPluginRegistrations
  .map((entry) => entry.plugin.id)
  .toSorted((left, right) => left.localeCompare(right));

const bundledWebSearchPluginIdSet = new Set<string>(BUNDLED_WEB_SEARCH_PLUGIN_IDS);

type BundledWebSearchProviderEntry = PluginWebSearchProviderEntry & { pluginId: string };

let bundledWebSearchProvidersCache: BundledWebSearchProviderEntry[] | null = null;

function loadBundledWebSearchProviders(): BundledWebSearchProviderEntry[] {
  if (!bundledWebSearchProvidersCache) {
    bundledWebSearchProvidersCache = bundledWebSearchPluginRegistrations.flatMap(({ plugin }) =>
      capturePluginRegistration(plugin).webSearchProviders.map((provider) => ({
        ...provider,
        pluginId: plugin.id,
      })),
    );
  }
  return bundledWebSearchProvidersCache;
}

export function resolveBundledWebSearchPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return registry.plugins
    .filter((plugin) => plugin.origin === "bundled" && bundledWebSearchPluginIdSet.has(plugin.id))
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return loadBundledWebSearchProviders();
}

export function resolveBundledWebSearchPluginId(
  providerId: string | undefined,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  return loadBundledWebSearchProviders().find((provider) => provider.id === providerId)?.pluginId;
}
