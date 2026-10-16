// Public image-generation helpers and types for provider plugins.

export {
  createOpenAiCompatibleImageGenerationProvider,
  type OpenAiCompatibleImageProviderRequestBody,
  type OpenAiCompatibleImageProviderRequestParams,
  type OpenAiCompatibleImageRequestMode,
} from "../image-generation/openai-compatible-image-provider.js";
export { inlineOpenAiCompatibleImageUrls } from "../image-generation/openai-compatible-image-urls.js";

export {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  generatedImageAssetFromOpenAiCompatibleEntry,
  imageFileExtensionForMimeType,
  imageSourceUploadFileName,
  parseImageDataUrl,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
  sniffImageMimeType,
  toImageDataUrl,
  type ImageMimeTypeDetection,
  type OpenAiCompatibleImageResponseEntry,
  type OpenAiCompatibleImageResponsePayload,
} from "../image-generation/image-assets.js";

export type {
  GeneratedImageAsset,
  ImageGenerationOpenAIBackground,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationProviderConfiguredContext,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "../image-generation/types.js";
