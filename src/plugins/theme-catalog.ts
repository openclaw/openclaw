import { createHash } from "node:crypto";
import type { ThemeArtwork, ThemeCatalogEntry } from "../../packages/gateway-protocol/src/theme.js";
import { buildControlUiResourcePath } from "../gateway/control-ui-resource-routes.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";

const catalogByPlugin = new WeakMap<PluginManifestRecord, ThemeCatalogEntry[]>();

function currentSnapshot() {
  // Appearance follows the live Gateway even when an agent retains an older runtime scope.
  return getProcessGatewayPluginMetadataSnapshot() ?? getCurrentPluginMetadataSnapshot();
}

function pluginThemes(plugin: PluginManifestRecord): ThemeCatalogEntry[] {
  const cached = catalogByPlugin.get(plugin);
  if (cached) {
    return cached;
  }
  const themes: ThemeCatalogEntry[] = [];
  for (const { id, definition, artwork } of plugin.themeDefinitions ?? []) {
    const resourceUrl = (kind: "hat" | "critter", artId: string, svg: string) => {
      const hash = createHash("sha256").update(svg).digest("hex").slice(0, 12);
      return `${buildControlUiResourcePath("pluginThemeArt", "", plugin.id, [id, kind, artId])}?v=${hash}`;
    };
    const projected: ThemeArtwork | undefined = artwork
      ? {
          ...(artwork.hats
            ? {
                hats: Object.fromEntries(
                  Object.entries(artwork.hats).map(([artId, art]) => [
                    artId,
                    { url: resourceUrl("hat", artId, art.svg) },
                  ]),
                ),
              }
            : {}),
          ...(artwork.critters
            ? {
                critters: Object.fromEntries(
                  Object.entries(artwork.critters).map(([artId, { svg, ...metadata }]) => [
                    artId,
                    { url: resourceUrl("critter", artId, svg), ...metadata },
                  ]),
                ),
              }
            : {}),
        }
      : undefined;
    themes.push({
      id: `${plugin.id}/${id}`,
      name: definition.name,
      description: definition.description,
      ...(definition.mascot !== undefined ? { mascot: definition.mascot } : {}),
      ...(definition.workingPhrases !== undefined
        ? { workingPhrases: definition.workingPhrases }
        : {}),
      ...(definition.critters !== undefined ? { critters: definition.critters } : {}),
      ...(definition.avatarHat !== undefined ? { avatarHat: definition.avatarHat } : {}),
      ...(projected ? { artwork: projected } : {}),
      source: "plugin",
      pluginId: plugin.id,
      modes: (["light", "dark"] as const).filter((mode) => Boolean(definition[mode])),
      definition,
    });
  }
  catalogByPlugin.set(plugin, themes);
  return themes;
}

/** Returns captured bytes from the enabled owner's current published generation. */
export function resolvePluginThemeArtwork(
  pluginId: string,
  themeId: string,
  kind: "hat" | "critter",
  artId: string,
): string | undefined {
  const snapshot = currentSnapshot();
  if (!snapshot?.index.plugins.some((plugin) => plugin.pluginId === pluginId && plugin.enabled)) {
    return undefined;
  }
  const theme = snapshot.plugins
    .find((plugin) => plugin.id === pluginId)
    ?.themeDefinitions?.find((entry) => entry.id === themeId);
  const artwork = kind === "hat" ? theme?.artwork?.hats : theme?.artwork?.critters;
  return artwork && Object.hasOwn(artwork, artId) ? artwork[artId]?.svg : undefined;
}

/** Reads the published inventory only; explicit plugin lifecycle operations replace its palettes. */
export function listPluginThemes(): ThemeCatalogEntry[] {
  const snapshot = currentSnapshot();
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
      return pluginThemes(plugin);
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
