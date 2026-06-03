import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

export type PluginRegistryIdNormalizerOptions = {
  manifestRegistry?: PluginManifestRegistry;
  lookUpTable?: Pick<{ manifestRegistry: PluginManifestRegistry }, "manifestRegistry">;
};

function normalizePluginRegistryAlias(value: string): string {
  return value.trim();
}

function normalizePluginRegistryAliasKey(value: string): string {
  return normalizePluginRegistryAlias(value).toLowerCase();
}

function collectObjectKeys(value: Record<string, unknown> | undefined): readonly string[] {
  return value ? Object.keys(value) : [];
}

function listPluginRegistryNormalizerAliases(plugin: PluginManifestRecord): readonly string[] {
  return [
    plugin.id,
    ...(plugin.providers ?? []),
    ...(plugin.channels ?? []),
    ...(plugin.setup?.providers?.map((provider) => provider.id) ?? []),
    ...(plugin.cliBackends ?? []),
    ...(plugin.setup?.cliBackends ?? []),
    ...collectObjectKeys(plugin.modelCatalog?.providers),
    ...collectObjectKeys(plugin.modelCatalog?.aliases),
    ...collectObjectKeys(plugin.providerAuthAliases),
    ...(plugin.legacyPluginIds ?? []),
  ];
}

type PluginRegistryNormalizerAliasEntry = {
  pluginId: string;
  registryId: string;
  aliases: readonly string[];
};

function readPluginRegistryNormalizerAliasEntry(
  plugin: PluginManifestRecord,
): PluginRegistryNormalizerAliasEntry | undefined {
  try {
    const pluginId = normalizePluginRegistryAlias(plugin.id);
    if (!pluginId) {
      return undefined;
    }
    return {
      pluginId,
      registryId: plugin.id,
      aliases: listPluginRegistryNormalizerAliases(plugin),
    };
  } catch {
    return undefined;
  }
}

export function createPluginRegistryIdNormalizer(
  index: InstalledPluginIndex,
  options: PluginRegistryIdNormalizerOptions = {},
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of index.plugins) {
    if (!plugin.pluginId) {
      continue;
    }
    const pluginId = normalizePluginRegistryAlias(plugin.pluginId);
    if (pluginId) {
      aliases.set(normalizePluginRegistryAliasKey(pluginId), plugin.pluginId);
    }
  }
  const registry =
    options.lookUpTable?.manifestRegistry ??
    options.manifestRegistry ??
    loadPluginManifestRegistryForInstalledIndex({
      index,
      includeDisabled: true,
    });
  const manifestAliasEntries = registry.plugins
    .map((plugin) => readPluginRegistryNormalizerAliasEntry(plugin))
    .filter((entry): entry is PluginRegistryNormalizerAliasEntry => Boolean(entry))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
  for (const entry of manifestAliasEntries) {
    aliases.set(normalizePluginRegistryAliasKey(entry.pluginId), entry.registryId);
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizePluginRegistryAlias(alias);
      const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
      if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
        aliases.set(normalizedAliasKey, entry.pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const trimmed = normalizePluginRegistryAlias(pluginId);
    return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
  };
}
