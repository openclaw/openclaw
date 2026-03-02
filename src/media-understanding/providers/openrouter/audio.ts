import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  normalizeBaseUrl,
  requireTranscriptionText,
} from "../shared.js";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_AUDIO_MODEL = "google/gemini-3-flash-preview";
const DEFAULT_OPENROUTER_AUDIO_PROMPT = "Transcribe the audio.";

const MIME_FORMAT_MAP: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
};

/** Map a MIME type to the `format` string OpenRouter expects in `input_audio`. */
export function mimeToAudioFormat(mime: string | undefined): string {
  return MIME_FORMAT_MAP[mime ?? ""] ?? "wav";
}

type OpenRouterChatPayload = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

export async function transcribeOpenRouterAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = params.model?.trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
  const prompt = params.prompt?.trim() || DEFAULT_OPENROUTER_AUDIO_PROMPT;
  const url = `${baseUrl}/chat/completions`;

  const headers = new Headers(params.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "input_audio",
            input_audio: {
              data: params.buffer.toString("base64"),
              format: mimeToAudioFormat(params.mime),
            },
          },
        ],
      },
    ],
  };

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    await assertOkOrThrowHttpError(res, "OpenRouter audio transcription failed");
    const payload = (await res.json()) as OpenRouterChatPayload;
    const text = requireTranscriptionText(
      payload.choices?.[0]?.message?.content,
      "OpenRouter audio transcription response missing content",
    );
    return { text, model };
  } finally {
    await release();
  }
}
