import type { ControlUiRepositorySource } from "../../packages/gateway-protocol/src/plugin-control-ui-repositories.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { err, ok, type Result } from "../../packages/normalization-core/src/result.js";

/** Repository discovery is backend metadata and does not require a browser artifact. */
export function normalizeManifestRepositorySources(
  value: unknown,
): Result<ControlUiRepositorySource[] | undefined, string> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!Array.isArray(value) || value.length > 16) {
    return err("repositorySources must contain at most 16 sources");
  }
  const ids = new Set<string>();
  const sources: ControlUiRepositorySource[] = [];
  for (const source of value) {
    if (
      !isRecord(source) ||
      Object.keys(source).some((key) => !["id", "label", "searchMethod"].includes(key)) ||
      typeof source.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(source.id) ||
      typeof source.label !== "string" ||
      !source.label.trim() ||
      source.label.length > 100 ||
      typeof source.searchMethod !== "string" ||
      !source.searchMethod.trim() ||
      source.searchMethod.length > 200 ||
      ids.has(source.id)
    ) {
      return err("Repository sources require unique ids, labels and search methods");
    }
    ids.add(source.id);
    sources.push({ id: source.id, label: source.label, searchMethod: source.searchMethod });
  }
  return ok(sources);
}
