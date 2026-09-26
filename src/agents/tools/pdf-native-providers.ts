/**
 * Direct SDK/HTTP calls for providers that support native PDF document input.
 * This bypasses shared model runtime's content type system which does not have a "document" type.
 */

import { resolveAnthropicMessagesUrl } from "@openclaw/ai/transports";
import { readResponseBodySnippet } from "../../infra/http-error-body.js";
import {
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfigWithOriginTrust,
} from "../../media-understanding/shared.js";
import { normalizeProviderTransportWithPlugin } from "../../plugins/provider-runtime.js";
import { isRecord } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createProviderErrorTextRedactor } from "../provider-http-errors.js";
import type { ModelProviderRequestTransportOverrides } from "../provider-request-config.js";
import { unwrapSecretSentinelsForProviderEgress } from "../provider-secret-egress.js";
import { resolveProviderTransportSsrFPolicy } from "../provider-transport-fetch.js";

type PdfInput = {
  base64: string;
  filename?: string;
};

const NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS = 120_000;
const NATIVE_PDF_ERROR_BODY_MAX_BYTES = 8 * 1024;
const NATIVE_PDF_ERROR_BODY_MAX_CHARS = 400;

type NativePdfProviderRequestConfig = {
  headers?: Record<string, string>;
  request?: ModelProviderRequestTransportOverrides;
};

type NativePdfJsonRequest = {
  provider: string;
  api: string;
  label: string;
  baseUrl?: string;
  defaultBaseUrl: string;
  resolveUrl: (baseUrl: string) => string;
  headers: Record<string, string>;
  body: unknown;
  request?: ModelProviderRequestTransportOverrides;
  defaultAuthHeader: string;
  signal?: AbortSignal;
};

async function postNativePdfJson(params: NativePdfJsonRequest): Promise<Record<string, unknown>> {
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, trustConfiguredBaseUrlOrigin } =
    resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: params.baseUrl,
      defaultBaseUrl: params.defaultBaseUrl,
      defaultHeaders: params.headers,
      request: params.request,
      provider: params.provider,
      api: params.api,
      capability: "other",
      transport: "http",
    });
  headers.set("Content-Type", "application/json");
  const url = params.resolveUrl(baseUrl);
  const failureLabel = `${params.label} PDF request failed`;
  for (const [name, value] of headers.entries()) {
    headers.set(
      name,
      unwrapSecretSentinelsForProviderEgress(value, `${failureLabel} header handoff`),
    );
  }
  const redactErrorText = createProviderErrorTextRedactor({
    headers,
    request: params.request,
    defaultAuthHeader: params.defaultAuthHeader,
  });
  const { response, release } = await postJsonRequest({
    url,
    headers,
    body: params.body,
    timeoutMs: NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn: fetch,
    allowPrivateNetwork,
    ssrfPolicy: resolveProviderTransportSsrFPolicy({
      baseUrl,
      url,
      allowPrivateNetwork,
      trustConfiguredBaseUrlOrigin,
    }),
    dispatcherPolicy,
  });

  try {
    if (!response.ok) {
      const body = await readResponseBodySnippet(response, {
        maxBytes: NATIVE_PDF_ERROR_BODY_MAX_BYTES,
        maxChars: NATIVE_PDF_ERROR_BODY_MAX_CHARS,
        redact: redactErrorText,
      });
      throw new Error(
        `${failureLabel} (${response.status} ${redactErrorText(response.statusText)})${body ? `: ${body}` : ""}`,
      );
    }

    const json = await readProviderJsonResponse<unknown>(response, `${params.label} PDF response`);
    if (!isRecord(json)) {
      throw new Error(`${params.label} PDF response was not JSON.`);
    }
    return json;
  } finally {
    await release();
  }
}

type AnthropicResponseContent = Array<{ type: string; text?: string }>;

export async function anthropicAnalyzePdf(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  pdfs: PdfInput[];
  maxTokens?: number;
  baseUrl?: string;
  requestConfig?: NativePdfProviderRequestConfig;
  signal?: AbortSignal;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Anthropic PDF: apiKey required");
  }

  const json = await postNativePdfJson({
    provider: "anthropic",
    api: "anthropic-messages",
    label: "Anthropic",
    baseUrl: params.baseUrl,
    defaultBaseUrl: resolveAnthropicMessagesUrl(undefined).replace(/\/messages$/u, ""),
    resolveUrl: resolveAnthropicMessagesUrl,
    headers: {
      ...params.requestConfig?.headers,
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "pdfs-2024-09-25",
    },
    body: {
      model: params.modelId,
      max_tokens: params.maxTokens ?? 4096,
      messages: [
        {
          role: "user",
          content: [
            ...params.pdfs.map((pdf) => ({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
            })),
            { type: "text", text: params.prompt },
          ],
        },
      ],
    },
    request: params.requestConfig?.request,
    defaultAuthHeader: "x-api-key",
    signal: params.signal,
  });

  const responseContent = json.content as AnthropicResponseContent | undefined;
  if (!Array.isArray(responseContent)) {
    throw new Error("Anthropic PDF response missing content array.");
  }

  const text = responseContent
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");

  if (!text.trim()) {
    throw new Error("Anthropic PDF returned no text.");
  }

  return text.trim();
}

type GeminiCandidate = {
  content?: { parts?: Array<{ text?: string }> };
};

export async function geminiAnalyzePdf(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  pdfs: PdfInput[];
  baseUrl?: string;
  requestConfig?: NativePdfProviderRequestConfig;
  signal?: AbortSignal;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Gemini PDF: apiKey required");
  }

  const transport = normalizeProviderTransportWithPlugin({
    provider: "google",
    context: {
      provider: "google",
      api: "google-generative-ai",
      baseUrl: params.baseUrl,
    },
  }) ?? { baseUrl: params.baseUrl };
  const json = await postNativePdfJson({
    provider: "google",
    api: "google-generative-ai",
    label: "Gemini",
    baseUrl: transport.baseUrl,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    resolveUrl: (baseUrl) =>
      `${baseUrl.replace(/\/v1beta$/i, "")}/v1beta/models/${encodeURIComponent(params.modelId)}:generateContent`,
    headers: { ...params.requestConfig?.headers, "x-goog-api-key": apiKey },
    body: {
      contents: [
        {
          role: "user",
          parts: [
            ...params.pdfs.map((pdf) => ({
              inline_data: { mime_type: "application/pdf", data: pdf.base64 },
            })),
            { text: params.prompt },
          ],
        },
      ],
    },
    request: params.requestConfig?.request,
    defaultAuthHeader: "x-goog-api-key",
    signal: params.signal,
  });

  const candidates = json.candidates as GeminiCandidate[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Gemini PDF returned no candidates.");
  }

  const candidate = candidates.at(0);
  if (!candidate) {
    throw new Error("Gemini PDF returned no candidates.");
  }
  const textParts = candidate.content?.parts?.filter((part) => typeof part.text === "string") ?? [];
  const text = textParts.map((part) => part.text).join("");

  if (!text.trim()) {
    throw new Error("Gemini PDF returned no text.");
  }

  return text.trim();
}
