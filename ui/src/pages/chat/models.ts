// Control UI model metadata boundary.
import type { ModelCatalogEntry } from "../../api/types.ts";

export function applyModelCatalogResult(models: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(models)) {
    return null;
  }
  return models as ModelCatalogEntry[];
}
