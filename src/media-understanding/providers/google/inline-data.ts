import { normalizeGoogleModelId } from "../../../agents/models-config.providers.js";
import { parseGeminiAuth } from "../../../infra/gemini-auth.js";
import { assertOkOrThrowHttpError, fetchWithTimeoutGuarded, normalizeBaseUrl } from "../shared.js";

export async function generateGeminiInlineDataText(params: {
  buffer: Buffer;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultPrompt: string;
  defaultMime: string;
  httpErrorLabel: string;
  missingTextError: string;
}): Promise<{ text: string; model: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, params.defaultBaseUrl);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = (() => {
    const trimmed = params.model?.trim();
    if (!trimmed) {
      return params.defaultModel;
    }
    return normalizeGoogleModelId(trimmed);
  })();
  const url = `${baseUrl}/models/${model}:generateContent`;

  const authHeaders = parseGeminiAuth(params.apiKey);
  const headers = new Headers(params.headers);
  for (const [key, value] of Object.entries(authHeaders.headers)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  const prompt = (() => {
    const trimmed = params.prompt?.trim();
    return trimmed || params.defaultPrompt;
  })();

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: params.mime ?? params.defaultMime,
              data: params.buffer.toString("base64"),
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
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    await assertOkOrThrowHttpError(res, params.httpErrorLabel);

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
      throw new Error(params.missingTextError);
    }
    return { text, model };
  } finally {
    await release();
  }
}
