import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { buildConfiguredModelCatalog } from "../agents/model-selection.js";
import { getRuntimeConfig } from "../config/config.js";

export type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  const cfg = (params?.getConfig ?? getRuntimeConfig)();
  if (cfg.models?.mode === "replace") {
    return buildConfiguredModelCatalog({ cfg });
  }
  return await loadModelCatalog({ config: cfg });
}
