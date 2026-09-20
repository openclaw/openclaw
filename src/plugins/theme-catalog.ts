import type { ThemeCatalogEntry } from "../../packages/gateway-protocol/src/theme.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";

/** Reads the published inventory only; explicit plugin lifecycle operations replace its palettes. */
export function listPluginThemes(): ThemeCatalogEntry[] {
  // Appearance follows the live Gateway even when an agent retains an older runtime scope.
  const snapshot = getProcessGatewayPluginMetadataSnapshot() ?? getCurrentPluginMetadataSnapshot();
  if (!snapshot) {
    return [];
  }
  const enabled = new Set(
    snapshot.index.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.pluginId),
  );
  return snapshot.plugins
    .flatMap((plugin): ThemeCatalogEntry[] => {
      if (!enabled.has(plugin.id)) {
        return [];
      }
      return (plugin.themeDefinitions ?? []).map(({ id, definition }) => ({
        id: `${plugin.id}/${id}`,
        name: definition.name,
        description: definition.description,
        source: "plugin",
        pluginId: plugin.id,
        modes: (["light", "dark"] as const).filter((mode) => Boolean(definition[mode])),
        definition,
      }));
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
