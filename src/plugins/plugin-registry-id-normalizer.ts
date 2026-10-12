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
  return createPluginManifestIdNormalizer(
    registry,
    index.plugins.map((plugin) => plugin.pluginId),
  );
}
