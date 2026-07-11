// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

export type ModelCatalogResult = {
  models: ModelCatalogEntry[];
  catalogMode?: "replace";
};

type ModelCatalogCacheEntry = {
  expiresAt: number;
  result: ModelCatalogResult;
  inFlight?: Promise<ModelCatalogResult>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, ModelCatalogCacheEntry>();

type LoadModelsOptions = {
  refresh?: boolean;
  includeMetadata?: boolean;
};

export function loadModels(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean },
): Promise<ModelCatalogEntry[]>;
export function loadModels(
  client: GatewayBrowserClient,
  opts: { refresh?: boolean; includeMetadata: true },
): Promise<ModelCatalogResult>;
export async function loadModels(
  client: GatewayBrowserClient,
  opts?: LoadModelsOptions,
): Promise<ModelCatalogEntry[] | ModelCatalogResult> {
  const result = await loadModelCatalogResult(client, opts);
  return opts?.includeMetadata ? result : result.models;
}

async function loadModelCatalogResult(
  client: GatewayBrowserClient,
  opts?: LoadModelsOptions,
): Promise<ModelCatalogResult> {
  const cached = modelCatalogCache.get(client);
  const now = Date.now();
  if (!opts?.refresh && cached?.result && cached.expiresAt > now) {
    return cached.result;
  }
  if (!opts?.refresh && cached?.inFlight) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight = requestModels(client, cached?.result)
    .then((response) => {
      const latest = modelCatalogCache.get(client);
      if (!latest || latest.inFlight === inFlight) {
        modelCatalogCache.set(client, {
          expiresAt: response.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          result: response.result,
        });
      }
      return response.result;
    })
    .finally(() => {
      const latest = modelCatalogCache.get(client);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  modelCatalogCache.set(client, {
    expiresAt: cached?.expiresAt ?? 0,
    result: cached?.result ?? { models: [] },
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
  fallback: ModelCatalogResult | undefined,
): Promise<{ result: ModelCatalogResult; fresh: boolean }> {
  try {
    const response = await client.request<ModelCatalogResult>("models.list", {
      view: "configured",
    });
    const result: ModelCatalogResult = {
      models: response?.models ?? [],
      ...(response?.catalogMode === "replace" ? { catalogMode: "replace" as const } : {}),
    };
    return { result, fresh: true };
  } catch {
    // Failed loads fall back without extending the TTL so the next call retries.
    return { result: fallback ?? { models: [] }, fresh: false };
  }
}
