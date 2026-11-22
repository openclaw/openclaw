import type { ActiveMediaModel } from "../../../packages/media-understanding-common/src/active-model.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";

/** Media understanding sees the turn's model when one is known. */
export function resolveActiveMediaModel(
  provider: string,
  model: string | undefined,
  catalog: readonly ModelCatalogEntry[] | undefined,
): ActiveMediaModel | undefined {
  return model
    ? { provider, model, api: findModelInCatalog(catalog ?? [], provider, model)?.api }
    : undefined;
}
