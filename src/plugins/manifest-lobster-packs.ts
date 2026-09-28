import { LOBSTER_LOCAL_ID_PATTERN } from "../../packages/gateway-protocol/src/lobsterdex.js";
import { isThemeId } from "../../packages/gateway-protocol/src/theme.js";
import type { PluginManifestLobsterPack } from "./manifest-types.js";

export function normalizeManifestLobsterPacks(
  value: unknown,
  pluginId: string,
): { ok: true; lobsterPacks?: PluginManifestLobsterPack[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value) || value.length > 8) {
    return { ok: false, error: "lobsterPacks must be an array with at most 8 entries" };
  }
  if (value.length && (pluginId === "builtin" || !isThemeId(`${pluginId}/x`))) {
    return { ok: false, error: "lobsterPacks require a portable plugin ID outside builtin/" };
  }
  const ids = new Set<string>();
  const lobsterPacks: PluginManifestLobsterPack[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `lobsterPacks[${index}] must be an object` };
    }
    // SAFETY: raw is a non-null, non-array object; both supported fields are checked below.
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => key !== "id" && key !== "source") ||
      typeof entry.id !== "string" ||
      !LOBSTER_LOCAL_ID_PATTERN.test(entry.id) ||
      ids.has(entry.id)
    ) {
      return {
        ok: false,
        error: `lobsterPacks[${index}] requires a unique safe id and JSON source`,
      };
    }
    if (
      typeof entry.source !== "string" ||
      !/^(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*\.json$/i.test(entry.source)
    ) {
      return {
        ok: false,
        error: `lobsterPacks[${index}].source must be a JSON file inside the plugin root`,
      };
    }
    ids.add(entry.id);
    lobsterPacks.push({ id: entry.id, source: entry.source });
  }
  return { ok: true, lobsterPacks };
}
