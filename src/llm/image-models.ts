import type { ImagesModel } from "./types.js";

const imageModelRegistry: Map<string, Map<string, ImagesModel>> = new Map();

export function registerImageModel(model: ImagesModel): void {
  let providerModels = imageModelRegistry.get(model.provider);
  if (!providerModels) {
    providerModels = new Map<string, ImagesModel>();
    imageModelRegistry.set(model.provider, providerModels);
  }
  providerModels.set(model.id, model);
}

export function registerImageModels(models: readonly ImagesModel[]): void {
  for (const model of models) {
    registerImageModel(model);
  }
}

export function clearRegisteredImageModelsForTest(): void {
  imageModelRegistry.clear();
}

export function getImageModel(provider: string, modelId: string): ImagesModel | undefined {
  const providerModels = imageModelRegistry.get(provider);
  return providerModels?.get(modelId);
}

export function getImageProviders(): string[] {
  return Array.from(imageModelRegistry.keys());
}

export function getImageModels(provider: string): ImagesModel[] {
  const models = imageModelRegistry.get(provider);
  return models ? Array.from(models.values()) : [];
}
