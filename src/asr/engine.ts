export type {
  AudioTranscriptionRequest as AsrTranscribeRequest,
  AudioTranscriptionResult as AsrTranscribeResult,
} from "../media-understanding/types.js";

import type {
  AudioTranscriptionRequest as AsrTranscribeRequest,
  AudioTranscriptionResult as AsrTranscribeResult,
} from "../media-understanding/types.js";

/**
 * Dedicated engine interface for ASR (Automatic Speech Recognition).
 *
 * Unlike the broader {@link MediaUnderstandingProvider} where `transcribeAudio`
 * is optional, every `AsrEngine` **must** implement `transcribe`.
 */
export interface AsrEngine {
  readonly id: string;

  transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult>;
}
