import { fetchWithTimeout } from "../../utils/fetch-timeout.js";

const ZHIPU_PROVIDER = "zhipu" as const;
const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/";
const ZHIPU_TIMEOUT_MS = 10_000;

type ZhipuJsonRecord = Record<string, unknown>;

export type ZhipuChatCompletionsRequest = {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: unknown;
  }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
};

export type ZhipuChatCompletionsResponse = {
  id?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: unknown;
      reasoning_content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
} & ZhipuJsonRecord;

function extractZhipuText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (!item || typeof item !== "object") {
          return "";
        }
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

export function extractZhipuAssistantText(response: ZhipuChatCompletionsResponse): string {
  const message = response.choices?.[0]?.message;
  const contentText = extractZhipuText(message?.content).trim();
  if (contentText) {
    return contentText;
  }
  return extractZhipuText(message?.reasoning_content).trim();
}

export function extractZhipuAssistantTextWithReasoningFallback(
  response: ZhipuChatCompletionsResponse,
): string {
  const message = response.choices?.[0]?.message;
  const contentText = extractZhipuText(message?.content).trim();
  if (contentText) {
    return contentText;
  }
  if (message?.reasoning_content) {
    return extractZhipuText(message.reasoning_content).trim();
  }
  return "";
}

export type ZhipuProviderErrorShape = {
  provider: typeof ZHIPU_PROVIDER;
  endpoint: string;
  status?: number;
  code?: string;
  message: string;
};

export class ZhipuProviderError extends Error {
  readonly provider: typeof ZHIPU_PROVIDER;
  readonly endpoint: string;
  readonly status?: number;
  readonly code?: string;

  constructor(shape: ZhipuProviderErrorShape) {
    super(shape.message);
    this.name = "ZhipuProviderError";
    this.provider = shape.provider;
    this.endpoint = shape.endpoint;
    this.status = shape.status;
    this.code = shape.code;
  }
}

function resolveZhipuApiKey(): string {
  const key = process.env.ZHIPU_API_KEY?.trim();
  if (key) {
    return key;
  }
  throw new ZhipuProviderError({
    provider: ZHIPU_PROVIDER,
    endpoint: "auth",
    code: "missing_api_key",
    message: "Missing ZHIPU_API_KEY",
  });
}

function resolveUrl(endpoint: string): string {
  return `${ZHIPU_BASE_URL.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const data = body as {
    error?: { code?: unknown };
    code?: unknown;
  };
  const code = data.error?.code ?? data.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function readErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const data = body as {
    error?: { message?: unknown };
    message?: unknown;
    msg?: unknown;
  };
  const message = data.error?.message ?? data.message ?? data.msg;
  return typeof message === "string" ? message : undefined;
}

async function zhipuRequest(params: {
  endpoint: string;
  method: "GET" | "POST";
  payload?: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  const url = resolveUrl(params.endpoint);
  const apiKey = resolveZhipuApiKey();

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: params.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(params.payload ? { "content-type": "application/json" } : {}),
        },
        ...(params.payload ? { body: JSON.stringify(params.payload) } : {}),
      },
      params.timeoutMs ?? ZHIPU_TIMEOUT_MS,
    );
  } catch (error) {
    throw new ZhipuProviderError({
      provider: ZHIPU_PROVIDER,
      endpoint: params.endpoint,
      message: error instanceof Error ? error.message : "Network request failed",
    });
  }

  const body = await readJsonSafe(response);
  if (!response.ok) {
    throw new ZhipuProviderError({
      provider: ZHIPU_PROVIDER,
      endpoint: params.endpoint,
      status: response.status,
      code: readErrorCode(body),
      message:
        readErrorMessage(body) ??
        `ZHIPU request failed with status ${response.status} at ${params.endpoint}`,
    });
  }

  return body;
}

export async function zhipuChatCompletions(
  payload: ZhipuChatCompletionsRequest,
): Promise<ZhipuChatCompletionsResponse> {
  return (await zhipuRequest({
    endpoint: "/chat/completions",
    method: "POST",
    payload,
  })) as ZhipuChatCompletionsResponse;
}

export async function zhipuOcrLayoutParsing(payload: unknown): Promise<ZhipuJsonRecord> {
  return (await zhipuRequest({
    endpoint: "/layout_parsing",
    method: "POST",
    payload,
  })) as ZhipuJsonRecord;
}

export async function zhipuImagesGenerations(payload: unknown): Promise<ZhipuJsonRecord> {
  return (await zhipuRequest({
    endpoint: "/images/generations",
    method: "POST",
    payload,
  })) as ZhipuJsonRecord;
}

export async function zhipuVideosGenerations(payload: unknown): Promise<ZhipuJsonRecord> {
  return (await zhipuRequest({
    endpoint: "/videos/generations",
    method: "POST",
    payload,
  })) as ZhipuJsonRecord;
}

export async function zhipuAsyncResult(id: string): Promise<ZhipuJsonRecord> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new ZhipuProviderError({
      provider: ZHIPU_PROVIDER,
      endpoint: "/async-result/{id}",
      code: "missing_id",
      message: "Missing async result id",
    });
  }
  return (await zhipuRequest({
    endpoint: `/async-result/${encodeURIComponent(trimmed)}`,
    method: "GET",
  })) as ZhipuJsonRecord;
}

export async function zhipuAudioSpeech(payload: unknown): Promise<ZhipuJsonRecord> {
  return (await zhipuRequest({
    endpoint: "/audio/speech",
    method: "POST",
    payload,
  })) as ZhipuJsonRecord;
}
