import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { transcribeOpenAiCompatibleAudio } from "../openai/audio.js";

export const DEFAULT_WHISPER_BASE_URL = "http://localhost:8200/v1";
const DEFAULT_WHISPER_MODEL = "whisper-1";

/**
 * Transcribe audio using Whisper (OpenAI Whisper or compatible servers).
 *
 * Whisper is OpenAI's open-source speech recognition model, widely used
 * for self-hosted transcription. This provider supports:
 * - Official OpenAI Whisper API (cloud)
 * - Self-hosted Whisper servers (e.g., whisper-asr-webservice, faster-whisper)
 * - OpenAI-compatible Whisper implementations
 *
 * Configuration:
 * - baseUrl: Whisper server endpoint (default: http://localhost:8200/v1)
 * - model: Model size (tiny, base, small, medium, large, large-v2, large-v3)
 * - language: Optional language code (e.g., "en", "ar", "fr") for improved accuracy
 *
 * See: https://github.com/openai/whisper
 */
export async function transcribeWhisperAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const baseUrl = params.baseUrl?.trim() || DEFAULT_WHISPER_BASE_URL;
  const model = params.model?.trim() || DEFAULT_WHISPER_MODEL;

  return transcribeOpenAiCompatibleAudio({
    ...params,
    baseUrl,
    model,
    // Whisper API key is typically not required for self-hosted instances
    // but we'll pass it through if provided
    apiKey: params.apiKey || "whisper-local",
  });
}
