import { getInstalledPluginIndexFacts } from "./installed-plugin-index-facts.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginManifestIdNormalizer } from "./plugin-manifest-id-normalizer.js";

/** Inputs used to resolve aliases for installed plugin ids. */
export type PluginRegistryIdNormalizerOptions = {
  manifestRegistry?: PluginManifestRegistry;
  lookUpTable?: Pick<{ manifestRegistry: PluginManifestRegistry }, "manifestRegistry">;
};

/** Creates a normalizer that maps provider/channel/catalog aliases back to plugin ids. */
export function createPluginRegistryIdNormalizer(
  index: InstalledPluginIndex,
  options: PluginRegistryIdNormalizerOptions = {},
): (pluginId: string) => string {
  const registry =
    options.lookUpTable?.manifestRegistry ??
    options.manifestRegistry ??
    loadPluginManifestRegistryForInstalledIndex({
      index,
      includeDisabled: true,
    });
  // Immutable inventories own alias facts; manifest projections retain separate answers.
  const facts = getInstalledPluginIndexFacts(index);
  const cached = facts?.idNormalizers?.get(registry);
  if (cached) {
    return cached;
  }
  const normalize = createPluginManifestIdNormalizer(
    registry,
    index.plugins.map((plugin) => plugin.pluginId),
  );
  if (facts) {
    (facts.idNormalizers ??= new WeakMap()).set(registry, normalize);
  }
  return normalize;
}
