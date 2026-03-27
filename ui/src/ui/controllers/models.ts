import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";

export type ModelCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
};

type ModelCatalogRefreshEntry = {
  client: GatewayBrowserClient;
  clearOnError: boolean;
  promise: Promise<void>;
};

type RefreshModelCatalogOptions = {
  clearOnError?: boolean;
};

const modelCatalogRefreshes = new WeakMap<ModelCatalogState, ModelCatalogRefreshEntry>();

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

export async function refreshModelCatalog(
  state: ModelCatalogState,
  opts: RefreshModelCatalogOptions = {},
): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    state.chatModelsLoading = false;
    state.chatModelCatalog = [];
    return;
  }
  const inFlight = modelCatalogRefreshes.get(state);
  if (inFlight?.client === client) {
    if (opts.clearOnError) {
      inFlight.clearOnError = true;
    }
    return inFlight.promise;
  }
  state.chatModelsLoading = true;
  const entry: ModelCatalogRefreshEntry = {
    client,
    clearOnError: Boolean(opts.clearOnError),
    promise: Promise.resolve(),
  };
  entry.promise = (async () => {
    try {
      const models = await requestModels(client);
      if (state.client === client) {
        state.chatModelCatalog = models;
      }
    } catch {
      if (entry.clearOnError && state.client === client) {
        state.chatModelCatalog = [];
      }
    } finally {
      const current = modelCatalogRefreshes.get(state);
      if (current === entry) {
        state.chatModelsLoading = false;
        modelCatalogRefreshes.delete(state);
      }
    }
  })();
  modelCatalogRefreshes.set(state, entry);
  return entry.promise;
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
