import type { VideoDescriptionRequest, VideoDescriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  normalizeBaseUrl,
  requireTranscriptionText,
} from "../shared.js";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_VIDEO_MODEL = "google/gemini-3-flash-preview";
const DEFAULT_OPENROUTER_VIDEO_PROMPT = "Describe the video.";

type OpenRouterChatPayload = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

export async function describeOpenRouterVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = params.model?.trim() || DEFAULT_OPENROUTER_VIDEO_MODEL;
  const prompt = params.prompt?.trim() || DEFAULT_OPENROUTER_VIDEO_PROMPT;
  const mime = params.mime ?? "video/mp4";
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
            type: "video_url",
            video_url: {
              url: `data:${mime};base64,${params.buffer.toString("base64")}`,
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
    await assertOkOrThrowHttpError(res, "OpenRouter video description failed");
    const payload = (await res.json()) as OpenRouterChatPayload;
    const text = requireTranscriptionText(
      payload.choices?.[0]?.message?.content,
      "OpenRouter video description response missing content",
    );
    return { text, model };
  } finally {
    await release();
  }
}
