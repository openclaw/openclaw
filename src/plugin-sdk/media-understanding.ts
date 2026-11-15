export type {
  AudioTranscriptionResult,
  ImageDescriptionResult,
  ImagesDescriptionInput,
  ImagesDescriptionResult,
  StructuredExtractionImageInput,
  StructuredExtractionInput,
  StructuredExtractionResult,
  StructuredExtractionTextInput,
  VideoDescriptionResult,
} from "../../packages/media-understanding-common/src/types.js";
export type {
  AudioTranscriptionConfigContext,
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
  MediaUnderstandingProvider,
  MediaUnderstandingProviderAuthContext,
  StructuredExtractionRequest,
} from "../media-understanding/provider-types.js";
export type {
  AudioTranscriptionRequest,
  MediaUnderstandingProviderAuthResult,
  MediaUnderstandingProviderRequestAuth,
  MediaUnderstandingProviderSyntheticAuthResult,
  VideoDescriptionRequest,
} from "../media-understanding/types.js";

export {
  describeImageWithModel,
  describeImageWithModelPayloadTransform,
  describeImagesWithModel,
  describeImagesWithModelPayloadTransform,
} from "../media-understanding/image-runtime.js";
export {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  describeOpenAiCompatibleVideo,
  resolveMediaUnderstandingString,
  type OpenAiCompatibleVideoPayload,
} from "../media-understanding/openai-compatible-video.ts";
export { transcribeOpenAiCompatibleAudio } from "../media-understanding/openai-compatible-audio.js";
