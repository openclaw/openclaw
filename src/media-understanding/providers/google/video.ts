import type { VideoDescriptionRequest, VideoDescriptionResult } from "../../types.js";
import { normalizeGoogleModelId } from "../../../agents/models-config.providers.js";
<<<<<<< HEAD
import { fetchWithTimeout, normalizeBaseUrl, readErrorResponse } from "../shared.js";
=======
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";
>>>>>>> upstream/main

export const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_GOOGLE_VIDEO_MODEL;
  }
  return normalizeGoogleModelId(trimmed);
}

function resolvePrompt(prompt?: string): string {
  const trimmed = prompt?.trim();
  return trimmed || DEFAULT_GOOGLE_VIDEO_PROMPT;
}

export async function describeGeminiVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_GOOGLE_VIDEO_BASE_URL);
<<<<<<< HEAD
=======
  const allowPrivate = Boolean(params.baseUrl?.trim());
>>>>>>> upstream/main
  const model = resolveModel(params.model);
  const url = `${baseUrl}/models/${model}:generateContent`;

  const headers = new Headers(params.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("x-goog-api-key")) {
    headers.set("x-goog-api-key", params.apiKey);
  }

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: resolvePrompt(params.prompt) },
          {
            inline_data: {
              mime_type: params.mime ?? "video/mp4",
              data: params.buffer.toString("base64"),
            },
          },
        ],
      },
    ],
  };

<<<<<<< HEAD
  const res = await fetchWithTimeout(
=======
  const { response: res, release } = await fetchWithTimeoutGuarded(
>>>>>>> upstream/main
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    params.timeoutMs,
    fetchFn,
<<<<<<< HEAD
  );

  if (!res.ok) {
    const detail = await readErrorResponse(res);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Video description failed (HTTP ${res.status})${suffix}`);
  }

  const payload = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part?.text?.trim())
    .filter(Boolean)
    .join("\n");
  if (!text) {
    throw new Error("Video description response missing text");
  }
  return { text, model };
=======
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    if (!res.ok) {
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Video description failed (HTTP ${res.status})${suffix}`);
    }

    const payload = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part) => part?.text?.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) {
      throw new Error("Video description response missing text");
    }
    return { text, model };
  } finally {
    await release();
  }
>>>>>>> upstream/main
}
