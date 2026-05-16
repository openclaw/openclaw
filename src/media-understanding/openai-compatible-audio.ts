import { OPENAI_AUDIO_TRANSCRIPTIONS_API } from "./openai-audio-api.js";
// OpenAI-compatible audio transcription adapter for providers exposing the
// /audio/transcriptions API shape.
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "./shared.js";
import type {
  AudioTranscriptSegment,
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "./types.js";

type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
  provider?: string;
};

// Shared implementation for OpenAI-style /audio/transcriptions providers.
function resolveModel(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  return trimmed || fallback;
}

function resolveStringOption(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) {
      return text;
    }
  }
  return undefined;
}

function normalizeTranscriptSegments(value: unknown): AudioTranscriptSegment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const segments: AudioTranscriptSegment[] = [];
  for (const segment of value) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      continue;
    }
    const record = segment as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      continue;
    }
    const extra = { ...record };
    delete extra.text;
    delete extra.start;
    delete extra.end;
    delete extra.speaker;
    delete extra.id;
    delete extra.type;
    const { start, end, speaker, id, type } = record;
    const normalized: AudioTranscriptSegment = { ...extra, text };
    if (typeof start === "number" && Number.isFinite(start)) {
      normalized.start = start;
    }
    if (typeof end === "number" && Number.isFinite(end)) {
      normalized.end = end;
    }
    if (typeof speaker === "string") {
      const trimmedSpeaker = speaker.trim();
      if (trimmedSpeaker) {
        normalized.speaker = trimmedSpeaker;
      }
    }
    if (typeof id === "string" || typeof id === "number") {
      normalized.id = id;
    }
    if (typeof type === "string") {
      const trimmedType = type.trim();
      if (trimmedType) {
        normalized.type = trimmedType;
      }
    }
    segments.push(normalized);
  }
  return segments.length > 0 ? segments : undefined;
}

function assertJsonResponseFormat(responseFormat: string | undefined): void {
  if (!responseFormat) {
    return;
  }
  const normalized = responseFormat.trim().toLowerCase();
  if (normalized === "json" || normalized === "verbose_json" || normalized === "diarized_json") {
    return;
  }
  throw new Error(
    `OpenAI-compatible audio media understanding requires a JSON response_format; unsupported response_format "${responseFormat}"`,
  );
}

function assertPromptSupportedByModel(params: { model: string; prompt?: string }): void {
  const prompt = params.prompt?.trim();
  if (!prompt) {
    return;
  }
  if (params.model.trim().toLowerCase() !== "gpt-4o-transcribe-diarize") {
    return;
  }
  throw new Error(
    `OpenAI-compatible audio model "${params.model}" does not support prompt; omit prompt for diarized transcription`,
  );
}

/** Sends an OpenAI-compatible audio transcription request and returns validated text output. */
export async function transcribeOpenAiCompatibleAudio(
  params: OpenAiCompatibleAudioParams,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const apiKey = params.auth?.kind === "api-key" ? params.auth.apiKey : params.apiKey;
  // Explicit auth:none suppresses bearer headers even if legacy apiKey params are present.
  const defaultHeaders =
    params.auth?.kind === "none" || !apiKey
      ? undefined
      : {
          authorization: `Bearer ${apiKey}`,
        };
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: params.defaultBaseUrl,
      headers: params.headers,
      request: params.request,
      defaultHeaders,
      provider: params.provider,
      api: OPENAI_AUDIO_TRANSCRIPTIONS_API,
      capability: "audio",
      transport: "media-understanding",
    });
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model, params.defaultModel);
  const responseFormat = resolveStringOption(
    params.responseFormat,
    params.query?.response_format,
    params.query?.responseFormat,
  );
  const chunkingStrategy = resolveStringOption(
    params.chunkingStrategy,
    params.query?.chunking_strategy,
    params.query?.chunkingStrategy,
  );
  assertJsonResponseFormat(responseFormat);
  assertPromptSupportedByModel({ model, prompt: params.prompt });
  // Keep multipart construction centralized so provider tests cover filename and MIME behavior.
  const form = buildAudioTranscriptionFormData({
    buffer: params.buffer,
    fileName: params.fileName,
    mime: params.mime,
    fields: {
      model,
      language: params.language,
      prompt: params.prompt,
      response_format: responseFormat,
      chunking_strategy: chunkingStrategy,
    },
  });

  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    pinDns: false,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = await readProviderJsonObjectResponse(res, "Audio transcription failed");
    const text = requireTranscriptionText(
      typeof payload.text === "string" ? payload.text : undefined,
      "Audio transcription response missing text",
    );
    const segments = normalizeTranscriptSegments(payload.segments);
    return { text, model, ...(segments ? { segments } : {}) };
  } finally {
    await release();
  }
}
