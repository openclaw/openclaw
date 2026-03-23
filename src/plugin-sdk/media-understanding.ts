// Public media-understanding helpers and types for provider plugins.

export type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionInput,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
  VideoDescriptionResult,
} from "../media-understanding/types.js";

export {
  describeImageWithModel,
  describeImagesWithModel,
} from "../media-understanding/image-runtime.js";
export { transcribeOpenAiCompatibleAudio } from "../media-understanding/openai-compatible-audio.js";
export {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "../media-understanding/shared.js";
export { deepgramMediaUnderstandingProvider } from "../../extensions/deepgram/media-understanding-provider.js";
export { groqMediaUnderstandingProvider } from "../../extensions/groq/media-understanding-provider.js";
