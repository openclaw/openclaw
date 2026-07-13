// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, ModelCatalogCacheEntry>();

export async function loadModels(client: GatewayBrowserClient): Promise<ModelCatalogEntry[]> {
  const cached = modelCatalogCache.get(client);
  const now = Date.now();
  if (cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = requestModels(client, cached?.models).finally(() => {
    const latest = modelCatalogCache.get(client);
    if (latest?.inFlight === inFlight) {
      delete latest.inFlight;
    }
  });
  modelCatalogCache.set(client, {
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
  });
  return inFlight;
}

export function applyModelCatalogResult(models: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(models)) {
    return null;
  }
  return models as ModelCatalogEntry[];
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
): Promise<ModelCatalogEntry[]> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
    });
    const models = result?.models ?? [];
    modelCatalogCache.set(client, {
      expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
      models,
    });
    return models;
  } catch {
    return fallback ?? [];
  }
}
