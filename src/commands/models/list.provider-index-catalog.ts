import {
  loadOpenClawProviderIndex,
  normalizeModelCatalogProviderId,
  planProviderIndexModelCatalogRows,
} from "../../model-catalog/index.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";

export function loadProviderIndexCatalogRowsForList(params: {
  providerFilter: string;
}): readonly NormalizedModelCatalogRow[] {
  const providerFilter = normalizeModelCatalogProviderId(params.providerFilter);
  if (!providerFilter) {
    return [];
  }
  return planProviderIndexModelCatalogRows({
    index: loadOpenClawProviderIndex(),
    providerFilter,
  }).rows;
}
