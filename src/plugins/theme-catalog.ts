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
      return (plugin.themeDefinitions ?? []).map(({ id, definition }) => {
        const entry: ThemeCatalogEntry = {
          id: `${plugin.id}/${id}`,
          name: definition.name,
          description: definition.description,
          source: "plugin",
          pluginId: plugin.id,
          modes: (["light", "dark"] as const).filter((mode) => Boolean(definition[mode])),
          definition,
        };
        if (definition.mascot !== undefined) {
          entry.mascot = definition.mascot;
        }
        if (definition.workingPhrases !== undefined) {
          entry.workingPhrases = definition.workingPhrases;
        }
        if (definition.critters !== undefined) {
          entry.critters = definition.critters;
        }
        if (definition.avatarHat !== undefined) {
          entry.avatarHat = definition.avatarHat;
        }
        return entry;
      });
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
