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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPluginRegistryArray(read: () => readonly unknown[] | undefined): readonly unknown[] {
  let values: readonly unknown[] | undefined;
  try {
    values = read();
  } catch {
    return [];
  }
  return Array.isArray(values) ? values : [];
}

function readPluginRegistryStringArray(read: () => readonly unknown[] | undefined): string[] {
  const values = readPluginRegistryArray(read);
  const strings: string[] = [];
  for (const index of values.keys()) {
    try {
      const value = values[index];
      if (typeof value === "string") {
        strings.push(value);
      }
    } catch {
      continue;
    }
  }
  return strings;
}

function collectObjectKeys(read: () => unknown): readonly string[] {
  let value: unknown;
  try {
    value = read();
  } catch {
    return [];
  }
  if (!isRecordValue(value)) {
    return [];
  }
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function readRecordStringFields(
  read: () => readonly unknown[] | undefined,
  field: string,
): string[] {
  const records = readPluginRegistryArray(read);
  const fields: string[] = [];
  for (const index of records.keys()) {
    try {
      const record = records[index];
      if (isRecordValue(record) && typeof record[field] === "string") {
        fields.push(record[field]);
      }
    } catch {
      continue;
    }
  }
  return fields;
}

function readPluginRegistryId(plugin: PluginManifestRecord): string | null {
  try {
    return typeof plugin.id === "string" && plugin.id ? plugin.id : null;
  } catch {
    return null;
  }
}

function listPluginRegistryNormalizerAliases(
  plugin: PluginManifestRecord,
  pluginId: string,
): readonly string[] {
  return [
    pluginId,
    ...readPluginRegistryStringArray(() => plugin.providers),
    ...readPluginRegistryStringArray(() => plugin.channels),
    ...readRecordStringFields(() => plugin.setup?.providers, "id"),
    ...readPluginRegistryStringArray(() => plugin.cliBackends),
    ...readPluginRegistryStringArray(() => plugin.setup?.cliBackends),
    ...collectObjectKeys(() => plugin.modelCatalog?.providers),
    ...collectObjectKeys(() => plugin.modelCatalog?.aliases),
    ...collectObjectKeys(() => plugin.providerAuthAliases),
    ...readPluginRegistryStringArray(() => plugin.legacyPluginIds),
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
  const registryPlugins = registry.plugins
    .flatMap((plugin) => {
      const pluginId = readPluginRegistryId(plugin);
      return pluginId ? [{ plugin, pluginId }] : [];
    })
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
  for (const { plugin, pluginId: rawPluginId } of registryPlugins) {
    const pluginId = normalizePluginRegistryAlias(rawPluginId);
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginRegistryAliasKey(pluginId), rawPluginId);
    for (const alias of listPluginRegistryNormalizerAliases(plugin, rawPluginId)) {
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
