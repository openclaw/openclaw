// Runtime bridge for plugin-provided migration hooks.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";
import type { MigrationProviderPlugin } from "./types.js";

function findMigrationProviderById(
  entries: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
  providerId: string,
): MigrationProviderPlugin | undefined {
  return entries.find((entry) => entry.provider.id === providerId)?.provider;
}

function resolveMigrationProviderConfig(params: {
  cfg?: OpenClawConfig;
  bundledCompatPluginIds: readonly string[];
}): OpenClawConfig | undefined {
  const enablementCompat = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds: [...params.bundledCompatPluginIds],
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds: [...params.bundledCompatPluginIds],
    env: process.env,
  });
}

function loadMigrationProviderRegistry(params: {
  cfg?: OpenClawConfig;
  pluginIds: string[];
  bundledCompatPluginIds: string[];
}) {
  const compatConfig = resolveMigrationProviderConfig({
    cfg: params.cfg,
    bundledCompatPluginIds: params.bundledCompatPluginIds,
  });
  return ensureStandaloneRuntimePluginRegistryLoaded({
    surface: "active",
    requiredPluginIds: params.pluginIds,
    loadOptions: {
      ...(compatConfig === undefined ? {} : { config: compatConfig }),
      onlyPluginIds: params.pluginIds,
      activate: false,
    },
  });
}

function mergeMigrationProviders(
  left: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
  right: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
): MigrationProviderPlugin[] {
  const merged = new Map<string, MigrationProviderPlugin>();
  for (const entry of [...left, ...right]) {
    if (!merged.has(entry.provider.id)) {
      merged.set(entry.provider.id, entry.provider);
    }
  }
  return [...merged.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

export function ensureStandaloneMigrationProviderRegistryLoaded(
  params: {
    cfg?: OpenClawConfig;
    providerId?: string;
  } = {},
) {
  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
    ...(params.providerId ? { value: params.providerId } : {}),
  });
  if (resolution.pluginIds.length === 0) {
    return undefined;
  }
  return loadMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds: resolution.pluginIds,
    bundledCompatPluginIds: resolution.bundledCompatPluginIds,
  });
}

export function resolvePluginMigrationProvider(params: {
  providerId: string;
  cfg?: OpenClawConfig;
}): MigrationProviderPlugin | undefined {
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProvider = findMigrationProviderById(
    activeRegistry?.migrationProviders ?? [],
    params.providerId,
  );
  if (activeProvider) {
    return activeProvider;
  }

  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
    value: params.providerId,
  });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return undefined;
  }
  const registry = loadMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
    bundledCompatPluginIds: resolution.bundledCompatPluginIds,
  });
  return findMigrationProviderById(registry?.migrationProviders ?? [], params.providerId);
}

export function resolvePluginMigrationProviders(
  params: {
    cfg?: OpenClawConfig;
  } = {},
): MigrationProviderPlugin[] {
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProviders = activeRegistry?.migrationProviders ?? [];
  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
  });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return mergeMigrationProviders(activeProviders, []);
  }
  const registry = loadMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
    bundledCompatPluginIds: resolution.bundledCompatPluginIds,
  });
  return mergeMigrationProviders(activeProviders, registry?.migrationProviders ?? []);
}
