import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry } from "./types.js";

type BundledWebFetchProviderEntry = PluginWebFetchProviderEntry & { pluginId: string };

const bundledWebFetchProvidersCache = new Map<string, BundledWebFetchProviderEntry[]>();

function resolveBundledWebFetchManifestPlugins(params: {
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
      plugin.origin === "bundled" && (plugin.contracts?.webFetchProviders?.length ?? 0) > 0,
  );
}

function loadBundledWebFetchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): BundledWebFetchProviderEntry[] {
  const pluginIds = resolveBundledWebFetchPluginIds(params ?? {});
  const cacheKey = pluginIds.join("\u0000");
  const cached = bundledWebFetchProvidersCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const providers =
    pluginIds.length === 0
      ? []
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds,
          pluginSdkResolution: "dist",
        }).webFetchProviders.map((entry) => ({
          pluginId: entry.pluginId,
          ...entry.provider,
        }));
  bundledWebFetchProvidersCache.set(cacheKey, providers);
  return providers;
}

export function resolveBundledWebFetchPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveBundledWebFetchManifestPlugins(params)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledWebFetchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): PluginWebFetchProviderEntry[] {
  return loadBundledWebFetchProviders(params);
}

export function resolveBundledWebFetchPluginId(
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
  return resolveBundledWebFetchManifestPlugins({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  }).find((plugin) =>
    plugin.contracts?.webFetchProviders?.some(
      (candidate) => candidate.trim().toLowerCase() === normalizedProviderId,
    ),
  )?.id;
}
