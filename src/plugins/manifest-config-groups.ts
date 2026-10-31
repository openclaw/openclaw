import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigUiGroup } from "../shared/config-ui-hints-types.js";

/** Invalid presentation metadata leaves the plugin's complete flat settings form available. */
export function normalizeConfigGroups(
  raw: unknown,
  schema: Record<string, unknown>,
): ConfigUiGroup[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || !isRecord(schema.properties)) {
    return undefined;
  }
  const ids = new Set<string>();
  const assigned = new Set<string>();
  const groups: ConfigUiGroup[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    if (
      !id ||
      !title ||
      ids.has(id) ||
      (entry.order !== undefined && !Number.isInteger(entry.order)) ||
      !Array.isArray(entry.properties) ||
      entry.properties.length === 0
    ) {
      return undefined;
    }
    const properties: string[] = [];
    for (const property of entry.properties) {
      if (
        typeof property !== "string" ||
        !property ||
        !Object.hasOwn(schema.properties, property) ||
        assigned.has(property)
      ) {
        return undefined;
      }
      assigned.add(property);
      properties.push(property);
    }
    ids.add(id);
    groups.push({
      id,
      title,
      ...(typeof entry.order === "number" ? { order: entry.order } : {}),
      properties,
    });
  }
  return groups;
}
