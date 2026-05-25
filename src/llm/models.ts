import { MODELS } from "./models.generated.js";
export {
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "./model-utils.js";
import type { Api, KnownProvider, Model } from "./types.js";

const modelRegistry: Map<string, Map<string, Model>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
  const providerModels = new Map<string, Model>();
  for (const [id, model] of Object.entries(models)) {
    providerModels.set(id, model as Model);
  }
  modelRegistry.set(provider, providerModels);
}

type ModelApi<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi }
  ? TApi extends Api
    ? TApi
    : never
  : never;

export function getModel<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): Model<ModelApi<TProvider, TModelId>> {
  const providerModels = modelRegistry.get(provider);
  return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
  return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
  provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
  const models = modelRegistry.get(provider);
  return models
    ? (Array.from(models.values()) as Model<
        ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>
      >[])
    : [];
}
