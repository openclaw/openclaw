import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry, ModelCatalogMeta } from "../types.ts";

export type ModelsListResponse = {
  models: ModelCatalogEntry[];
  _meta?: ModelCatalogMeta;
};

/**
 * Fetch the model catalog from the gateway.
 *
 * Accepts a {@link GatewayBrowserClient} (matching the existing ui/ controller
 * convention).  Returns an array of {@link ModelCatalogEntry}; on failure the
 * caller receives an empty array rather than throwing.
 */
export async function loadModels(client: GatewayBrowserClient): Promise<ModelCatalogEntry[]> {
  try {
    const result = await client.request<ModelsListResponse>("models.list", {});
    return result?.models ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch the model catalog with filter metadata from the gateway.
 *
 * Like {@link loadModels} but also returns the optional `_meta` object
 * that describes how many models were filtered and which filter mode
 * is active.
 */
export async function loadModelsWithMeta(
  client: GatewayBrowserClient,
): Promise<{ models: ModelCatalogEntry[]; meta: ModelCatalogMeta | null }> {
  try {
    const result = await client.request<ModelsListResponse>("models.list", {});
    return {
      models: result?.models ?? [],
      meta: result?._meta ?? null,
    };
  } catch {
    return { models: [], meta: null };
  }
}
