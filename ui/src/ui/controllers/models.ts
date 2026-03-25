import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";

export type ModelCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
};

const modelCatalogRefreshes = new WeakMap<ModelCatalogState, Promise<void>>();

async function requestModels(client: GatewayBrowserClient): Promise<ModelCatalogEntry[]> {
  const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {});
  return result?.models ?? [];
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
    return await requestModels(client);
  } catch {
    return [];
  }
}

export async function refreshModelCatalog(state: ModelCatalogState): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    state.chatModelsLoading = false;
    state.chatModelCatalog = [];
    return;
  }
  const inFlight = modelCatalogRefreshes.get(state);
  if (inFlight) {
    return inFlight;
  }
  state.chatModelsLoading = true;
  const request = (async () => {
    try {
      state.chatModelCatalog = await requestModels(client);
    } catch {
      // Keep the last known catalog so model pickers do not flash into a partial state.
    } finally {
      state.chatModelsLoading = false;
      modelCatalogRefreshes.delete(state);
    }
  })();
  modelCatalogRefreshes.set(state, request);
  return request;
}

export function ensureModelCatalog(state: ModelCatalogState): Promise<void> | undefined {
  if (
    !state.client ||
    !state.connected ||
    state.chatModelsLoading ||
    state.chatModelCatalog.length > 0
  ) {
    return;
  }
  return refreshModelCatalog(state);
}
