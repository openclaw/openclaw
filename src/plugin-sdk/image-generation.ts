// Public image-generation helpers and types for provider plugins.

export {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  generatedImageAssetFromOpenAiCompatibleEntry,
  imageFileExtensionForMimeType,
  imageSourceUploadFileName,
  parseImageDataUrl,
  parseOpenAiCompatibleImageResponse,
  sniffImageMimeType,
  toImageDataUrl,
  type ImageMimeTypeDetection,
  type OpenAiCompatibleImageResponseEntry,
  type OpenAiCompatibleImageResponsePayload,
} from "../image-generation/image-assets.js";

export type {
  GeneratedImageAsset,
  ImageGenerationBackground,
  ImageGenerationOpenAIBackground,
  ImageGenerationOpenAIModeration,
  ImageGenerationOpenAIOptions,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationProviderConfiguredContext,
  ImageGenerationProviderOptions,
  ImageGenerationQuality,
  ImageGenerationResolution,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "../image-generation/types.js";
