import { bundledWebSearchPluginRegistrations } from "../bundled-web-search-registry.js";
import { capturePluginRegistration } from "./captured-registration.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

type BundledWebSearchProviderEntry = PluginWebSearchProviderEntry & { pluginId: string };
type BundledWebSearchPluginRegistration = (typeof bundledWebSearchPluginRegistrations)[number];

let bundledWebSearchProvidersCache: BundledWebSearchProviderEntry[] | null = null;
let bundledWebSearchPluginIdsCache: string[] | null = null;

function resolveBundledWebSearchPlugin(
  entry: BundledWebSearchPluginRegistration,
): BundledWebSearchPluginRegistration["plugin"] | null {
  try {
    return entry.plugin;
  } catch {
    return null;
  }
}

function listBundledWebSearchPluginRegistrations() {
  return bundledWebSearchPluginRegistrations
    .map((entry) => {
      const plugin = resolveBundledWebSearchPlugin(entry);
      return plugin ? { ...entry, plugin } : null;
    })
    .filter(
      (
        entry,
      ): entry is BundledWebSearchPluginRegistration & {
        plugin: BundledWebSearchPluginRegistration["plugin"];
      } => Boolean(entry),
    );
}

function loadBundledWebSearchPluginIds(): string[] {
  if (!bundledWebSearchPluginIdsCache) {
    bundledWebSearchPluginIdsCache = listBundledWebSearchPluginRegistrations()
      .map(({ plugin }) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
  }
  return bundledWebSearchPluginIdsCache;
}

export function listBundledWebSearchPluginIds(): string[] {
  return loadBundledWebSearchPluginIds();
}

function loadBundledWebSearchProviders(): BundledWebSearchProviderEntry[] {
  if (!bundledWebSearchProvidersCache) {
    bundledWebSearchProvidersCache = listBundledWebSearchPluginRegistrations().flatMap(
      ({ plugin }) =>
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
  const bundledWebSearchPluginIdSet = new Set<string>(loadBundledWebSearchPluginIds());
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
