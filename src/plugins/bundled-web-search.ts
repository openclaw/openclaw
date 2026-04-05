import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

type BundledWebSearchProviderEntry = PluginWebSearchProviderEntry & { pluginId: string };

const bundledWebSearchProvidersCache = new Map<string, BundledWebSearchProviderEntry[]>();

function resolveBundledWebSearchManifestPlugins(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}) {
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  }).plugins.filter(
    (plugin) =>
      plugin.origin === "bundled" && (plugin.contracts?.webSearchProviders?.length ?? 0) > 0,
  );
}

function loadBundledWebSearchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): BundledWebSearchProviderEntry[] {
  const pluginIds = resolveBundledWebSearchPluginIds(params ?? {});
  const cacheKey = pluginIds.join("\u0000");
  const cached = bundledWebSearchProvidersCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const providers =
    pluginIds.length === 0
      ? []
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds,
          pluginSdkResolution: "dist",
        }).webSearchProviders.map((entry) => ({
          pluginId: entry.pluginId,
          ...entry.provider,
        }));
  bundledWebSearchProvidersCache.set(cacheKey, providers);
  return providers;
}

export function resolveBundledWebSearchPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveBundledWebSearchManifestPlugins(params)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledWebSearchPluginIds(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveBundledWebSearchPluginIds(params ?? {});
}

export function listBundledWebSearchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): PluginWebSearchProviderEntry[] {
  return loadBundledWebSearchProviders(params);
}

export function resolveBundledWebSearchPluginId(
  providerId: string | undefined,
  params?: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
  },
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!normalizedProviderId) {
    return undefined;
  }
  return resolveBundledWebSearchManifestPlugins({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  }).find((plugin) =>
    plugin.contracts?.webSearchProviders?.some(
      (candidate) => candidate.trim().toLowerCase() === normalizedProviderId,
    ),
  )?.id;
}
