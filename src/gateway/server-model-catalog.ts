import { getRuntimeConfig } from "../config/io.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;

type GatewayModelCatalogState = {
  lastSuccessfulCatalog: GatewayModelChoice[] | null;
  refreshPromise: Promise<GatewayModelChoice[]> | null;
  stale: boolean;
  staleGeneration: number;
};

type RetryableCatalogReason = "empty" | "error";
type LoadModelCatalogWithGatewayRetry = (params?: {
  config?: ReturnType<typeof getRuntimeConfig>;
  useCache?: boolean;
  readOnly?: boolean;
  onRetryableResult?: (reason: RetryableCatalogReason) => void;
}) => Promise<GatewayModelChoice[]>;

const gatewayModelCatalogState: GatewayModelCatalogState = {
  lastSuccessfulCatalog: null,
  refreshPromise: null,
  stale: true,
  staleGeneration: 0,
};

async function loadCurrentModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<{ catalog: GatewayModelChoice[]; retryableReason: RetryableCatalogReason | null }> {
  const { loadModelCatalog } = await import("../agents/model-catalog.js");
  // Internal Gateway-only hook. Keep this in sync with the internalParams cast in
  // src/agents/model-catalog.ts; it is intentionally omitted from the public Plugin SDK signature.
  const loadModelCatalogWithGatewayRetry = loadModelCatalog as LoadModelCatalogWithGatewayRetry;
  let retryableReason: RetryableCatalogReason | null = null;
  const catalog = await loadModelCatalogWithGatewayRetry({
    config: (params?.getConfig ?? getRuntimeConfig)(),
    onRetryableResult: (reason) => {
      retryableReason = reason;
    },
  });
  return { catalog, retryableReason };
}

function refreshGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  if (gatewayModelCatalogState.refreshPromise) {
    return gatewayModelCatalogState.refreshPromise;
  }
  const refreshGeneration = gatewayModelCatalogState.staleGeneration;
  const refreshPromise = loadCurrentModelCatalog(params)
    .then(({ catalog, retryableReason }) => {
      if (refreshGeneration !== gatewayModelCatalogState.staleGeneration) {
        gatewayModelCatalogState.stale = true;
      } else if (retryableReason !== null || catalog.length === 0) {
        gatewayModelCatalogState.stale = true;
      } else {
        gatewayModelCatalogState.lastSuccessfulCatalog = catalog;
        gatewayModelCatalogState.stale = false;
      }
      gatewayModelCatalogState.refreshPromise = null;
      return catalog;
    })
    .catch(() => {
      gatewayModelCatalogState.stale = true;
      gatewayModelCatalogState.refreshPromise = null;
      return gatewayModelCatalogState.lastSuccessfulCatalog ?? [];
    });
  gatewayModelCatalogState.refreshPromise = refreshPromise;
  return refreshPromise;
}

export function markGatewayModelCatalogStale(): void {
  gatewayModelCatalogState.stale = true;
  gatewayModelCatalogState.staleGeneration += 1;
}

function resetGatewayModelCatalogStateForTest(): void {
  gatewayModelCatalogState.lastSuccessfulCatalog = null;
  gatewayModelCatalogState.refreshPromise = null;
  gatewayModelCatalogState.stale = true;
  gatewayModelCatalogState.staleGeneration = 0;
}

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export async function __resetModelCatalogCacheForTest(): Promise<void> {
  resetGatewayModelCatalogStateForTest();
  const { resetModelCatalogCacheForTest } = await import("../agents/model-catalog.js");
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  const cached = gatewayModelCatalogState.lastSuccessfulCatalog;
  if (cached && !gatewayModelCatalogState.stale) {
    return cached;
  }
  if (cached) {
    void refreshGatewayModelCatalog(params);
    return cached;
  }
  const loadGeneration = gatewayModelCatalogState.staleGeneration;
  const { catalog, retryableReason } = await loadCurrentModelCatalog(params);
  if (catalog.length > 0) {
    const obsolete = loadGeneration !== gatewayModelCatalogState.staleGeneration;
    if (obsolete) {
      if (gatewayModelCatalogState.lastSuccessfulCatalog === null) {
        gatewayModelCatalogState.lastSuccessfulCatalog = catalog;
        gatewayModelCatalogState.stale = true;
      }
    } else {
      gatewayModelCatalogState.lastSuccessfulCatalog = catalog;
      gatewayModelCatalogState.stale = retryableReason !== null;
    }
  } else {
    gatewayModelCatalogState.stale = true;
  }
  return catalog;
}
