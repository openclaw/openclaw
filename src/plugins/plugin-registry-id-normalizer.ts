// Normalizes plugin registry identifiers from installed index records.
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

/** Inputs used to resolve aliases for installed plugin ids. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPluginManifestString(read: () => unknown): string | undefined {
  try {
    const value = read();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readPluginManifestStringArray(read: () => unknown): readonly string[] {
  try {
    const value = read();
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function readPluginManifestArray(read: () => unknown): readonly unknown[] {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function collectObjectKeys(read: () => unknown): readonly string[] {
  try {
    const value = read();
    return isRecord(value) ? Object.keys(value) : [];
  } catch {
    return [];
  }
}

function readSetupProviderIds(plugin: PluginManifestRecord): readonly string[] {
  return readPluginManifestArray(() => plugin.setup?.providers).flatMap((provider) => {
    if (!isRecord(provider)) {
      return [];
    }
    const providerId = readPluginManifestString(() => provider.id);
    return providerId ? [providerId] : [];
  });
}

function readPluginId(plugin: PluginManifestRecord): string | undefined {
  return readPluginManifestString(() => plugin.id);
}

function listPluginRegistryNormalizerAliases(plugin: PluginManifestRecord): readonly string[] {
  const pluginId = readPluginId(plugin);
  return [
    ...(pluginId ? [pluginId] : []),
    ...readPluginManifestStringArray(() => plugin.providers),
    ...readPluginManifestStringArray(() => plugin.channels),
    ...readSetupProviderIds(plugin),
    ...readPluginManifestStringArray(() => plugin.cliBackends),
    ...readPluginManifestStringArray(() => plugin.setup?.cliBackends),
    ...collectObjectKeys(() => plugin.modelCatalog?.providers),
    ...collectObjectKeys(() => plugin.modelCatalog?.aliases),
    ...collectObjectKeys(() => plugin.providerAuthAliases),
    ...readPluginManifestStringArray(() => plugin.legacyPluginIds),
  ];
}

/** Creates a normalizer that maps provider/channel/catalog aliases back to plugin ids. */
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
  for (const plugin of [...registry.plugins].toSorted((left, right) =>
    (readPluginId(left) ?? "").localeCompare(readPluginId(right) ?? ""),
  )) {
    const rawPluginId = readPluginId(plugin);
    if (!rawPluginId) {
      continue;
    }
    const pluginId = normalizePluginRegistryAlias(rawPluginId);
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginRegistryAliasKey(pluginId), rawPluginId);
    for (const alias of listPluginRegistryNormalizerAliases(plugin)) {
      const normalizedAlias = normalizePluginRegistryAlias(alias);
      const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
      if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
        aliases.set(normalizedAliasKey, pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const trimmed = normalizePluginRegistryAlias(pluginId);
    return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
  };
}
