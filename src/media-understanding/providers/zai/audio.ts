import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "../../types.js";
import { assertOkOrThrowHttpError, normalizeBaseUrl } from "../shared.js";

export const DEFAULT_ZAI_ASR_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

/**
 * 智谱 GLM ASR - 语音识别
 * API: https://open.bigmodel.cn/api/coding/paas/v4/audio/transcriptions
 */
export async function transcribeZaiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_ZAI_ASR_BASE_URL);
  
  // Convert Buffer to Uint8Array for FormData compatibility
  const uint8Array = new Uint8Array(params.buffer);
  const blob = new Blob([uint8Array], { type: "audio/wav" });
  
  const formData = new FormData();
  formData.append("file", blob, "audio.wav");
  formData.append("model", "glm-asr");
  if (params.language?.trim()) {
    formData.append("language", params.language.trim());
  }

  const url = `${baseUrl}/audio/transcriptions`;
  
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${params.apiKey}`,
    },
    body: formData,
  });

  await assertOkOrThrowHttpError(response, "Zai ASR transcription failed");

  const result = await response.json();
  
  // 智谱返回格式: { text: "识别文本", ... }
  const text = result.text || "";
  
  return { text };
}
