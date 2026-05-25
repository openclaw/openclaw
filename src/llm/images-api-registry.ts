import type {
  AssistantImages,
  ImagesApi,
  ImagesContext,
  ImagesFunction,
  ImagesModel,
  ImagesOptions,
} from "./types.js";

export type ImagesApiFunction = (
  model: ImagesModel,
  context: ImagesContext,
  options?: ImagesOptions,
) => Promise<AssistantImages>;

export interface ImagesApiProvider<
  TApi extends ImagesApi = ImagesApi,
  TOptions extends ImagesOptions = ImagesOptions,
> {
  api: TApi;
  generateImages: ImagesFunction<TApi, TOptions>;
}

interface ImagesApiProviderInternal {
  api: ImagesApi;
  generateImages: ImagesApiFunction;
}

type RegisteredImagesApiProvider = {
  provider: ImagesApiProviderInternal;
  sourceId?: string;
};

const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();

function wrapGenerateImages<TApi extends ImagesApi, TOptions extends ImagesOptions>(
  api: TApi,
  generateImages: ImagesFunction<TApi, TOptions>,
): ImagesApiFunction {
  return (model, context, options) => {
    if (model.api !== api) {
      throw new Error(`Mismatched api: ${model.api} expected ${api}`);
    }
    return generateImages(model as ImagesModel<TApi>, context, options as TOptions);
  };
}

export function registerImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
  provider: ImagesApiProvider<TApi, TOptions>,
  sourceId?: string,
): void {
  imagesApiProviderRegistry.set(provider.api, {
    provider: {
      api: provider.api,
      generateImages: wrapGenerateImages(provider.api, provider.generateImages),
    },
    sourceId,
  });
}

export function getImagesApiProvider(api: ImagesApi): ImagesApiProviderInternal | undefined {
  return imagesApiProviderRegistry.get(api)?.provider;
}
