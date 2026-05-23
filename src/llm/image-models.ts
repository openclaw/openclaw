import { IMAGE_MODELS } from "./image-models.generated.js";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.js";

const imageModelRegistry: Map<string, Map<string, ImagesModel>> = new Map();

for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
  const providerModels = new Map<string, ImagesModel>();
  for (const [id, model] of Object.entries(models)) {
    providerModels.set(id, model as ImagesModel);
  }
  imageModelRegistry.set(provider, providerModels);
}

type ImageModelApi<
  TProvider extends KnownImagesProvider,
  TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
> = (typeof IMAGE_MODELS)[TProvider][TModelId] extends { api: infer TApi }
  ? TApi extends ImagesApi
    ? TApi
    : never
  : never;

export function getImageModel<
  TProvider extends KnownImagesProvider,
  TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): ImagesModel<ImageModelApi<TProvider, TModelId>> {
  const providerModels = imageModelRegistry.get(provider);
  return providerModels?.get(modelId as string) as ImagesModel<ImageModelApi<TProvider, TModelId>>;
}

export function getImageProviders(): KnownImagesProvider[] {
  return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

export function getImageModels<TProvider extends KnownImagesProvider>(
  provider: TProvider,
): ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[] {
  const models = imageModelRegistry.get(provider);
  return models
    ? (Array.from(models.values()) as ImagesModel<
        ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>
      >[])
    : [];
}
