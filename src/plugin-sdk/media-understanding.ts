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
} from "../media-understanding/providers/image.js";
export { transcribeOpenAiCompatibleAudio } from "../media-understanding/providers/openai-compatible-audio.js";
export {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "../media-understanding/providers/shared.js";
