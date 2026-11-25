import { mergeModelCost } from "./model-cost.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.models.js";

export function getProviderModelId(model: ModelDefinitionConfig): string | undefined {
  return typeof model.id === "string" && model.id.trim() ? model.id : undefined;
}

export function mergeNormalizedProviderModel(
  existing: ModelDefinitionConfig,
  incoming: ModelDefinitionConfig,
): ModelDefinitionConfig {
  const cost = mergeModelCost(incoming.cost, existing.cost);
  return { ...incoming, ...existing, ...(cost ? { cost } : {}) };
}

/** Selects authored model rows before defaults erase field omissions. */
export function materializeConfiguredProviderModelRows<
  T extends Pick<ModelProviderConfig, "models">,
>(provider: T, normalizeModelId: (id: string) => string): T {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }
  const exactRows = new Map<string, ModelDefinitionConfig>();
  for (const model of provider.models) {
    const id = getProviderModelId(model)?.trim();
    if (id) {
      const existing = exactRows.get(id);
      exactRows.set(id, existing ? mergeNormalizedProviderModel(existing, model) : model);
    }
  }
  const normalizedIds = new Map<string, string>();
  const selectedRows = new Map<string, ModelDefinitionConfig>();
  for (const [id, model] of exactRows) {
    const normalized = normalizeModelId(id) || id;
    normalizedIds.set(id, normalized);
    // Exact destinations retain their omissions; other aliases do not donate fields.
    if (!selectedRows.has(normalized)) {
      selectedRows.set(normalized, exactRows.get(normalized) ?? model);
    }
  }
  const seen = new Set<string>();
  const models = provider.models.flatMap((model) => {
    const rawId = getProviderModelId(model);
    if (!rawId) {
      return [model];
    }
    const id = normalizedIds.get(rawId.trim())!;
    if (seen.has(id)) {
      return [];
    }
    seen.add(id);
    const selected = selectedRows.get(id)!;
    return [selected.id === id ? selected : { ...selected, id }];
  });
  return models.length === provider.models.length &&
    models.every((model, index) => model === provider.models[index])
    ? provider
    : { ...provider, models };
}
