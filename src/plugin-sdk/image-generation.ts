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
  sniffImageMimeType,
  toImageDataUrl,
  type ImageMimeTypeDetection,
  type OpenAiCompatibleImageResponseEntry,
  type OpenAiCompatibleImageResponsePayload,
} from "../image-generation/image-assets.js";

export {
  resolveProviderCapabilities,
  type ImageGenerationCapabilitiesResolver,
  type GeneratedImageAsset,
  type ImageGenerationBackground,
  type ImageGenerationOpenAIBackground,
  type ImageGenerationOpenAIModeration,
  type ImageGenerationOpenAIOptions,
  type ImageGenerationOutputFormat,
  type ImageGenerationProvider,
  type ImageGenerationProviderCapabilities,
  type ImageGenerationProviderConfiguredContext,
  type ImageGenerationProviderOptions,
  type ImageGenerationQuality,
  type ImageGenerationResolution,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageGenerationSourceImage,
} from "../image-generation/types.js";
