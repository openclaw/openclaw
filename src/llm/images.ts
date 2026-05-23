import "./providers/images/register-builtins.js";
import { getImagesApiProvider } from "./images-api-registry.js";
import type {
  AssistantImages,
  ImagesApi,
  ImagesContext,
  ImagesModel,
  ProviderImagesOptions,
} from "./types.js";

function resolveImagesApiProvider(api: ImagesApi) {
  const provider = getImagesApiProvider(api);
  if (!provider) {
    throw new Error(`No API provider registered for api: ${api}`);
  }
  return provider;
}

export async function generateImages<TApi extends ImagesApi>(
  model: ImagesModel<TApi>,
  context: ImagesContext,
  options?: ProviderImagesOptions,
): Promise<AssistantImages> {
  const provider = resolveImagesApiProvider(model.api);
  return provider.generateImages(model, context, options);
}
