import {
  MAX_THEME_DEFINITION_BYTES,
  isThemeId,
  normalizeThemeDefinition,
  THEME_LOCAL_ID_PATTERN,
  THEME_NAME_MAX_LENGTH,
  THEME_DESCRIPTION_MAX_LENGTH,
} from "../../packages/gateway-protocol/src/theme.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginDiagnostic, PluginManifestTheme } from "./manifest-types.js";
import { readPluginCacheFile } from "./plugin-cache-files.js";

const MAX_PLUGIN_THEMES = 32;

export function normalizeManifestThemes(
  value: unknown,
  pluginId: string,
): { ok: true; themes?: PluginManifestTheme[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_THEMES) {
    return {
      ok: false,
      error: `themes must be an array with at most ${MAX_PLUGIN_THEMES} entries`,
    };
  }
  if (value.length && (pluginId === "user" || !isThemeId(`${pluginId}/x`))) {
    return {
      ok: false,
      error: "themes require a portable plugin ID outside the reserved user namespace",
    };
  }
  const themes: PluginManifestTheme[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `themes[${index}] must be an object` };
    }
    // SAFETY: entry is a non-null, non-array object; every field is validated below.
    const { id, name, description, source } = entry as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !["id", "name", "description", "source"].includes(key)) ||
      typeof id !== "string" ||
      !THEME_LOCAL_ID_PATTERN.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > THEME_NAME_MAX_LENGTH ||
      typeof description !== "string" ||
      !description.trim() ||
      description.trim().length > THEME_DESCRIPTION_MAX_LENGTH ||
      Array.from(name + description).some(
        (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
      ) ||
      typeof source !== "string"
    ) {
      return {
        ok: false,
        error: `themes[${index}] requires a unique safe id, name, description, and JSON source`,
      };
    }
    const relativePath = source.replace(/^\.\//, "");
    if (!/^(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*\.json$/i.test(relativePath)) {
      return {
        ok: false,
        error: `themes[${index}].source must be a JSON file inside the plugin root`,
      };
    }
    ids.add(id);
    themes.push({ id, name: name.trim(), description: description.trim(), source: relativePath });
  }
  return { ok: true, themes };
}

/** Capture palettes with manifest metadata so a published generation never reads changed files. */
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
      const definition = normalizeThemeDefinition(JSON.parse(file.contents.toString("utf8")));
      if (definition.name !== theme.name || definition.description !== theme.description) {
        throw new Error("name and description must match the manifest declaration");
      }
      return [{ id: theme.id, definition }];
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
