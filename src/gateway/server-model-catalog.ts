import {
  loadModelCatalog,
  findModelInCatalog,
  type ModelCatalogEntry,
  type ModelInputType,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { getRuntimeConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";

export type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

/**
 * Load the gateway model catalog, augmented with custom models declared in
 * `models.providers.*.models[]` from the user config.  The built-in catalog
 * only contains first-party / plugin-contributed entries; user-configured
 * provider models (e.g. custom OpenAI-compatible endpoints) carry capability
 * declarations such as `input: ["text", "image"]` that must be visible to
 * capability-check helpers like `resolveGatewayModelSupportsImages`.
 */
export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  const cfg = (params?.getConfig ?? getRuntimeConfig)();
  const catalog = await loadModelCatalog({ config: cfg });

  // Augment with custom-configured provider models from models.providers.*.models[].
  // These are absent from the built-in Pi SDK registry but their capability
  // declarations (e.g. input: ["text", "image"]) should be honoured for routing.
  const providerConfigs = (cfg as { models?: { providers?: Record<string, ModelProviderConfig | undefined> } } | undefined)
    ?.models?.providers;

  if (!providerConfigs) {
    return catalog;
  }

  const extra: ModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of Object.entries(providerConfigs)) {
    const customModels = providerConfig?.models;
    if (!Array.isArray(customModels) || customModels.length === 0) {
      continue;
    }
    for (const m of customModels) {
      const id = typeof m?.id === "string" ? m.id.trim() : "";
      if (!id) {
        continue;
      }
      // Skip if already present (case-insensitive) to avoid duplicates.
      if (findModelInCatalog(catalog, providerId, id)) {
        continue;
      }
      const rawInput: unknown[] = Array.isArray(m.input) ? m.input : [];
      const input = rawInput.filter(
        (v): v is ModelInputType => v === "text" || v === "image" || v === "document",
      );
      extra.push({
        id,
        name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
        provider: providerId,
        contextWindow:
          typeof m.contextWindow === "number" && m.contextWindow > 0
            ? m.contextWindow
            : undefined,
        reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
        input: input.length > 0 ? input : undefined,
      });
    }
  }

  return extra.length > 0 ? [...catalog, ...extra] : catalog;
}
