export {
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "./model-utils.js";
import type { Model } from "./types.js";

const modelRegistry: Map<string, Map<string, Model>> = new Map();

export function registerModel(model: Model): void {
  let providerModels = modelRegistry.get(model.provider);
  if (!providerModels) {
    providerModels = new Map<string, Model>();
    modelRegistry.set(model.provider, providerModels);
  }
  providerModels.set(model.id, model);
}

export function registerModels(models: readonly Model[]): void {
  for (const model of models) {
    registerModel(model);
  }
}

export function clearRegisteredModelsForTest(): void {
  modelRegistry.clear();
}

export function getModel(provider: string, modelId: string): Model | undefined {
  const providerModels = modelRegistry.get(provider);
  return providerModels?.get(modelId);
}

export function getProviders(): string[] {
  return Array.from(modelRegistry.keys());
}

export function getModels(provider: string): Model[] {
  const models = modelRegistry.get(provider);
  return models ? Array.from(models.values()) : [];
}
