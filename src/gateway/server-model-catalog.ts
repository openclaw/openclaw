import { MODEL_CONTEXT_TOKEN_CACHE } from "../agents/context-cache.js";
import { applyDiscoveredContextWindows } from "../agents/context.js";
import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { normalizeProviderId } from "../agents/provider-id.js";
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
  const catalog = await loadModelCatalog({ config: (params?.getConfig ?? getRuntimeConfig)() });
  // Populate the synchronous context-window cache so that read-only callers
  // (e.g. session listing with allowAsyncLoad: false) can resolve context
  // windows for models discovered through the gateway model catalog.
  // Include both bare (e.g. "claude-sonnet-4-6") and provider-qualified
  // (e.g. "anthropic/claude-sonnet-4-6") keys so lookups from
  // resolveContextTokensForModel match either form.
  const discoveredModels: Array<{ id: string; contextWindow?: number }> = [];
  for (const entry of catalog) {
    if (entry.contextWindow) {
      discoveredModels.push({ id: entry.id, contextWindow: entry.contextWindow });
      // Match the normalization used by resolveContextTokensForModel at lookup
      // time, so aliased providers (e.g. "z.ai", "modelstudio") populate the
      // same qualified key the lookup probes ("zai/...", "qwen/...").
      const normalizedProvider = entry.provider ? normalizeProviderId(entry.provider) : "";
      if (normalizedProvider) {
        discoveredModels.push({
          id: `${normalizedProvider}/${entry.id}`,
          contextWindow: entry.contextWindow,
        });
      }
    }
  }
  applyDiscoveredContextWindows({ cache: MODEL_CONTEXT_TOKEN_CACHE, models: discoveredModels });
  return catalog;
}
