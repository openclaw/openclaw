import { isSelfContainedSvg } from "../../packages/gateway-protocol/src/svg-image.js";
import {
  MAX_THEME_DEFINITION_BYTES,
  isThemeId,
  normalizeThemeDefinition,
} from "../../packages/gateway-protocol/src/theme.js";
import type { PluginManifestRecord, PluginThemeArtwork } from "./manifest-registry.types.js";
import type { PluginDiagnostic, PluginManifestTheme } from "./manifest-types.js";
import { readPluginCacheFile } from "./plugin-cache-files.js";
import { PLUGIN_ACTIVITY_ICON_MAX_BYTES } from "./portable-icon-paths.js";

/** Capture palettes and artwork so a published generation never reads changed files. */
export function loadManifestThemeDefinitions(params: {
  pluginId: string;
  rootDir: string;
  themes: readonly PluginManifestTheme[] | undefined;
  rejectHardlinks: boolean;
  diagnostics: PluginDiagnostic[];
}): PluginManifestRecord["themeDefinitions"] {
  if (!params.themes?.length) {
    return undefined;
  }
  return params.themes.flatMap((theme) => {
    try {
      if (params.pluginId === "user" || !isThemeId(`${params.pluginId}/${theme.id}`)) {
        throw new Error(
          "qualified theme ID must be portable, outside user/, and at most 256 characters",
        );
      }
      const file = readPluginCacheFile({
        rootDir: params.rootDir,
        relativePath: theme.source,
        rejectHardlinks: params.rejectHardlinks,
        // Formatting whitespace is allowed; normalized portable definitions remain <=4 KiB.
        maxBytes: MAX_THEME_DEFINITION_BYTES * 4,
      });
      if (!file.ok) {
        throw new Error("source must be a readable JSON file inside the plugin root");
      }
      const definition = normalizeThemeDefinition(JSON.parse(file.contents.toString("utf8")), {
        hatIds: Object.keys(theme.hats ?? {}),
        critterIds: Object.keys(theme.critters ?? {}),
      });
      if (definition.name !== theme.name || definition.description !== theme.description) {
        throw new Error("name and description must match the manifest declaration");
      }
      const readSvg = (source: string): string => {
        const svgFile = readPluginCacheFile({
          rootDir: params.rootDir,
          relativePath: source,
          rejectHardlinks: params.rejectHardlinks,
          maxBytes: PLUGIN_ACTIVITY_ICON_MAX_BYTES,
        });
        if (!svgFile.ok) {
          throw new Error(
            `artwork ${source} must be a readable SVG inside the plugin root, at most ${PLUGIN_ACTIVITY_ICON_MAX_BYTES} bytes`,
          );
        }
        const svg = svgFile.contents.toString("utf8");
        if (!isSelfContainedSvg(svg)) {
          throw new Error(`artwork ${source} must be a self-contained SVG`);
        }
        return svg;
      };
      const artwork: PluginThemeArtwork = {
        ...(theme.hats
          ? {
              hats: Object.fromEntries(
                Object.entries(theme.hats).map(([id, source]) => [id, { svg: readSvg(source) }]),
              ),
            }
          : {}),
        ...(theme.critters
          ? {
              critters: Object.fromEntries(
                Object.entries(theme.critters).map(([id, { source, ...metadata }]) => [
                  id,
                  { svg: readSvg(source), ...metadata },
                ]),
              ),
            }
          : {}),
      };
      return [{ id: theme.id, definition, ...(theme.hats || theme.critters ? { artwork } : {}) }];
    } catch (error) {
      params.diagnostics.push({
        level: "warn",
        pluginId: params.pluginId,
        message: `theme ${theme.id} is unavailable: ${error instanceof Error ? error.message : "invalid definition"}`,
      });
      return [];
    }
  });
}
