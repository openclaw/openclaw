import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_SARVAM_AUDIO_BASE_URL = "https://api.sarvam.ai";
export const DEFAULT_SARVAM_AUDIO_MODEL = "saaras:v2.5";

const SARVAM_ACCEPTED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "audio/x-mpeg-3",
  "audio/x-mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/pcm_s16le",
  "audio/l16",
  "audio/raw",
  "audio/aac",
  "audio/x-aac",
  "audio/aiff",
  "application/octet-stream",
]);

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_SARVAM_AUDIO_MODEL;
}

function resolveUploadMime(mime?: string): string {
  const normalized = mime?.trim().toLowerCase();
  if (!normalized) {
    return "application/octet-stream";
  }
  const baseMime = normalized.split(";")[0]?.trim() || normalized;
  if (SARVAM_ACCEPTED_MIME_TYPES.has(baseMime)) {
    return baseMime;
  }
  return "application/octet-stream";
}

type SarvamSpeechToTextTranslateResponse = {
  transcript?: string;
  language_code?: string;
  model?: string;
};

export async function transcribeSarvamAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_SARVAM_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/speech-to-text-translate`;
  const model = resolveModel(params.model);

  const form = new FormData();
  const rawFileName = params.fileName?.trim();
  const fileName = rawFileName ? path.basename(rawFileName) : "audio";
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], { type: resolveUploadMime(params.mime) });
  form.append("file", blob, fileName);
  form.append("model", model);
  if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }
  if (params.language?.trim()) {
    form.append("language_code", params.language.trim());
  }
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === undefined) {
        continue;
      }
      form.append(key, String(value));
    }
  }

  const headers = new Headers(params.headers);
  if (!headers.has("api-subscription-key")) {
    headers.set("api-subscription-key", params.apiKey);
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "POST",
      headers,
      body: form,
    },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Audio transcription failed (HTTP ${res.status})${suffix}`);
    }

    const payload = (await res.json()) as SarvamSpeechToTextTranslateResponse;
    const transcript = payload.transcript?.trim();
    if (!transcript) {
      throw new Error("Audio transcription response missing transcript");
    }

    return {
      text: transcript,
      model: payload.model?.trim() || model,
    };
  } finally {
    await release();
  }
}
