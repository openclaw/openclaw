import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";

export type ModelCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelCatalogLoading: boolean;
};

export async function loadModelCatalog(state: ModelCatalogState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.chatModelCatalogLoading) {
    return;
  }
  state.chatModelCatalogLoading = true;
  try {
    const res = await state.client.request<{ models?: ModelCatalogEntry[] }>("models.list", {});
    if (res?.models && Array.isArray(res.models)) {
      state.chatModelCatalog = res.models;
    }
  } catch {
    // Silently ignore — model switcher just won't show options
  } finally {
    state.chatModelCatalogLoading = false;
  }
}

/**
 * Fetch the model catalog from the gateway.
 *
 * Accepts a {@link GatewayBrowserClient} (matching the existing ui/ controller
 * convention).  Returns an array of {@link ModelCatalogEntry}; on failure the
 * caller receives an empty array rather than throwing.
 */
export async function loadModels(client: GatewayBrowserClient): Promise<ModelCatalogEntry[]> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {});
    return result?.models ?? [];
  } catch {
    return [];
  }
}
