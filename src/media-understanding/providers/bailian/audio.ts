import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
  requireTranscriptionText,
} from "../shared.js";

export const DEFAULT_BAILIAN_AUDIO_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_BAILIAN_AUDIO_MODEL = "qwen3-asr-flash";
const MAX_BAILIAN_AUDIO_DATA_URL_BYTES = 10 * 1024 * 1024;

type BailianAsrContentPart = {
  text?: string;
};

type BailianAsrResponse = {
  choices?: Array<{
    message?: {
      content?: string | BailianAsrContentPart[];
    };
  }>;
};

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_BAILIAN_AUDIO_MODEL;
}

function buildAsrOptions(
  language: string | undefined,
  query: AudioTranscriptionRequest["query"],
): Record<string, string | number | boolean> | undefined {
  const options: Record<string, string | number | boolean> = {};
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      options[key] = value;
    }
  }
  if (language?.trim()) {
    options.language = language.trim();
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function extractBailianTranscript(content: string | BailianAsrContentPart[] | undefined): string {
  if (typeof content === "string") {
    return requireTranscriptionText(content, "Audio transcription response missing text");
  }

  const text = content
    ?.map((part) => part.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return requireTranscriptionText(text, "Audio transcription response missing text");
}

export async function transcribeBailianAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_BAILIAN_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/chat/completions`;
  const model = resolveModel(params.model);
  const mime = params.mime?.trim() || "application/octet-stream";
  if (params.buffer.byteLength > MAX_BAILIAN_AUDIO_DATA_URL_BYTES) {
    throw new Error("Bailian audio input exceeds the 10MB compatible-mode limit");
  }
  const audioData = `data:${mime};base64,${params.buffer.toString("base64")}`;
  const asrOptions = buildAsrOptions(params.language, params.query);

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const { response: res, release } = await postJsonRequest({
    url,
    headers,
    body: {
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioData,
              },
            },
          ],
        },
      ],
      stream: false,
      ...(asrOptions ? { asr_options: asrOptions } : undefined),
    },
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: allowPrivate,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as BailianAsrResponse;
    const text = extractBailianTranscript(payload.choices?.[0]?.message?.content);
    return { text, model };
  } finally {
    await release();
  }
}
