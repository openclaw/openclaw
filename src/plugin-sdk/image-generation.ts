// Public image-generation helpers and types for provider plugins.

export {
  createOpenAiCompatibleImageGenerationProvider,
  type OpenAiCompatibleImageProviderOptions,
  type OpenAiCompatibleImageProviderRequestBody,
  type OpenAiCompatibleImageProviderRequestParams,
  type OpenAiCompatibleImageRequestMode,
} from "../image-generation/openai-compatible-image-provider.js";

export {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  generatedImageAssetFromOpenAiCompatibleEntry,
  imageFileExtensionForMimeType,
  imageSourceUploadFileName,
  parseImageDataUrl,
  parseOpenAiCompatibleImageResponse,
  parseOpenAiCompatibleImageResponseAsync,
  sniffImageMimeType,
  toImageDataUrl,
  type ImageMimeTypeDetection,
  type OpenAiCompatibleImageResponseEntry,
  type OpenAiCompatibleImageResponsePayload,
  type OpenAiCompatibleImageUrlDownload,
  type OpenAiCompatibleImageUrlDownloader,
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
