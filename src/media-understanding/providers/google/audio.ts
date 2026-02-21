import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { generateGeminiInlineDataText } from "./inline-data.js";

export const DEFAULT_GOOGLE_AUDIO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";

export async function transcribeGeminiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_AUDIO_BASE_URL,
    defaultModel: DEFAULT_GOOGLE_AUDIO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_AUDIO_PROMPT,
    defaultMime: "audio/wav",
    httpErrorLabel: "Audio transcription failed",
    missingTextError: "Audio transcription response missing text",
  });
  return { text, model };
}
