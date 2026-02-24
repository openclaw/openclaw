import type { VideoDescriptionRequest, VideoDescriptionResult } from "../../types.js";
import { assertOkOrThrowHttpError, fetchWithTimeoutGuarded, normalizeBaseUrl } from "../shared.js";

export const DEFAULT_MOONSHOT_VIDEO_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MOONSHOT_VIDEO_MODEL = "kimi-k2.5";
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";

type MoonshotVideoPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
      reasoning_content?: string;
    };
  }>;
};

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_MOONSHOT_VIDEO_MODEL;
}

function resolvePrompt(prompt?: string): string {
  const trimmed = prompt?.trim();
  return trimmed || DEFAULT_MOONSHOT_VIDEO_PROMPT;
}

function coerceMoonshotText(payload: MoonshotVideoPayload): string | null {
  const message = payload.choices?.[0]?.message;
  if (!message) {
    return null;
  }
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  return null;
}

export async function describeMoonshotVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_MOONSHOT_VIDEO_BASE_URL);
  const model = resolveModel(params.model);
  const mime = params.mime ?? "video/mp4";
  const prompt = resolvePrompt(params.prompt);
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
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    params.timeoutMs,
    fetchFn,
  );

  try {
    await assertOkOrThrowHttpError(res, "Moonshot video description failed");
    const payload = (await res.json()) as MoonshotVideoPayload;
    const text = coerceMoonshotText(payload);
    if (!text) {
      throw new Error("Moonshot video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}
