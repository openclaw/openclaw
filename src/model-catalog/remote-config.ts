import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_REMOTE_MODEL_CATALOG_URL = "https://catalog.openclaw.ai/models/v2/catalog.json";
// Released clients stored downloads from this default. Until the first v2 download lands,
// an upgraded default install keeps serving that catalog, including offline.
const RETIRED_DEFAULT_REMOTE_MODEL_CATALOG_URL =
  "https://catalog.openclaw.ai/models/v1/catalog.json";

export function isRemoteModelCatalogRefreshEnabled(config: OpenClawConfig): boolean {
  return config.models?.catalogRefresh?.enabled !== false;
}

export function resolveRemoteCatalogUrl(config: OpenClawConfig): string {
  return config.models?.catalogRefresh?.url?.trim() || DEFAULT_REMOTE_MODEL_CATALOG_URL;
}

/** Whether a catalog downloaded from `sourceUrl` may serve the configured source. */
export function isRemoteCatalogSourceActive(config: OpenClawConfig, sourceUrl: string): boolean {
  const url = resolveRemoteCatalogUrl(config);
  return (
    sourceUrl === url ||
    (url === DEFAULT_REMOTE_MODEL_CATALOG_URL &&
      sourceUrl === RETIRED_DEFAULT_REMOTE_MODEL_CATALOG_URL)
  );
}
