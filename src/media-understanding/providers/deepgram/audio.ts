import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { assertOkOrThrowHttpError, fetchWithTimeoutGuarded, normalizeBaseUrl } from "../shared.js";

export const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
export const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_DEEPGRAM_AUDIO_MODEL;
}

type DeepgramTranscriptResponse = {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
};

export async function transcribeDeepgramAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_DEEPGRAM_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = resolveModel(params.model);

  const url = new URL(`${baseUrl}/listen`);
  url.searchParams.set("model", model);
  if (params.language?.trim()) {
    url.searchParams.set("language", params.language.trim());
  }
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Token ${params.apiKey}`);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", params.mime ?? "application/octet-stream");
  }

  const body = new Uint8Array(params.buffer);
  const { response: res, release } = await fetchWithTimeoutGuarded(
    url.toString(),
    {
      method: "POST",
      headers,
      body,
    },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as DeepgramTranscriptResponse;
    const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) {
      throw new Error("Audio transcription response missing transcript");
    }
    return { text: transcript, model };
  } finally {
    await release();
  }
}
