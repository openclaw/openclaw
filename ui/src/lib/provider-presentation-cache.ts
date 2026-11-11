import type { ModelCatalogResult } from "../api/types.ts";
import { modelCatalogCache, type ModelCatalogClient } from "./model-catalog-cache.ts";

/** Presentation derives from this connection's admitted catalog, never routing state. */
export function readCachedProviderPresentation(
  client: ModelCatalogClient | null | undefined,
  provider: string,
): NonNullable<ModelCatalogResult["providerPresentations"]>[string] | undefined {
  const cache = client ? modelCatalogCache.get(client) : undefined;
  if (!cache) {
    return undefined;
  }
  for (const entry of [...cache.entries.values()].toReversed()) {
    if (!entry.invalidated) {
      const presentation = entry.result?.providerPresentations?.[provider];
      if (presentation) {
        return presentation;
      }
      const model = entry.result?.models.find((row) => row.provider === provider);
      if (model) {
        return model;
      }
    }
  }
  return undefined;
}
