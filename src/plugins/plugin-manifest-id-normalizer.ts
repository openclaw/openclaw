import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

function listPluginRegistryNormalizerAliases(plugin: PluginManifestRecord): readonly string[] {
  return [
    plugin.id,
    ...(plugin.providers ?? []),
    ...(plugin.channels ?? []),
    ...(plugin.setup?.providers?.map((provider) => provider.id) ?? []),
    ...(plugin.cliBackends ?? []),
    ...(plugin.setup?.cliBackends ?? []),
    ...Object.keys(plugin.modelCatalog?.providers ?? {}),
    ...Object.keys(plugin.modelCatalog?.aliases ?? {}),
    ...Object.keys(plugin.providerAuthAliases ?? {}),
    ...(plugin.legacyPluginIds ?? []),
  ];
}

export function createPluginManifestIdNormalizer(
  registry: Pick<PluginManifestRegistry, "plugins">,
  installedPluginIds: readonly string[] = [],
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const pluginId of installedPluginIds) {
    const policyId = normalizePluginPolicyId(pluginId);
    if (policyId) {
      aliases.set(policyId, pluginId);
    }
  }
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginPolicyId(pluginId), plugin.id);
    for (const alias of listPluginRegistryNormalizerAliases(plugin)) {
      const policyId = normalizePluginPolicyId(alias);
      if (policyId && !aliases.has(policyId)) {
        aliases.set(policyId, pluginId);
      }
    }
  }
  return (pluginId) => aliases.get(normalizePluginPolicyId(pluginId)) ?? pluginId.trim();
}
