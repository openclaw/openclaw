/**
 * Direct SDK/HTTP calls for providers that support native PDF document input.
 * This bypasses pi-ai's content type system which does not have a "document" type.
 */

import { normalizeProviderTransportWithPlugin } from "../../plugins/provider-runtime.js";
import { isRecord } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

type PdfInput = {
  base64: string;
  filename?: string;
};

const DEFAULT_NATIVE_PDF_TIMEOUT_MS = 90_000;

function stringifyPdfNativeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logPdfNativeStart(params: {
  provider: "anthropic" | "google";
  modelId: string;
  pdfCount: number;
  timeoutMs: number;
}) {
  console.info(
    `[pdf/native] start provider=${params.provider} model=${params.modelId} pdfs=${params.pdfCount} timeoutMs=${params.timeoutMs}`,
  );
}

function logPdfNativeSuccess(params: {
  provider: "anthropic" | "google";
  modelId: string;
  pdfCount: number;
  timeoutMs: number;
  durationMs: number;
  textChars: number;
}) {
  console.info(
    `[pdf/native] success provider=${params.provider} model=${params.modelId} pdfs=${params.pdfCount} timeoutMs=${params.timeoutMs} durationMs=${params.durationMs} textChars=${params.textChars}`,
  );
}

function logPdfNativeFailure(params: {
  provider: "anthropic" | "google";
  modelId: string;
  pdfCount: number;
  timeoutMs: number;
  durationMs: number;
  error: unknown;
}) {
  console.error(
    `[pdf/native] failure provider=${params.provider} model=${params.modelId} pdfs=${params.pdfCount} timeoutMs=${params.timeoutMs} durationMs=${params.durationMs} error=${stringifyPdfNativeError(params.error)}`,
  );
}

async function fetchPdfNativeJson(params: {
  provider: "anthropic" | "google";
  modelId: string;
  pdfCount: number;
  url: string;
  init: RequestInit;
  timeoutMs?: number;
}): Promise<{ json: Record<string, unknown>; durationMs: number; timeoutMs: number }> {
  const timeoutMsRaw = params.timeoutMs ?? DEFAULT_NATIVE_PDF_TIMEOUT_MS;
  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.floor(timeoutMsRaw)
      : DEFAULT_NATIVE_PDF_TIMEOUT_MS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  logPdfNativeStart({
    provider: params.provider,
    modelId: params.modelId,
    pdfCount: params.pdfCount,
    timeoutMs,
  });

  try {
    const res = await fetch(params.url, {
      ...params.init,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `${params.provider === "anthropic" ? "Anthropic" : "Gemini"} PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`,
      );
    }

    const json = (await res.json().catch(() => null)) as unknown;
    if (!isRecord(json)) {
      throw new Error(
        `${params.provider === "anthropic" ? "Anthropic" : "Gemini"} PDF response was not JSON.`,
      );
    }
    return { json, durationMs: Date.now() - startedAt, timeoutMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      const timeoutError = new Error(
        `${params.provider === "anthropic" ? "Anthropic" : "Gemini"} PDF request timed out after ${timeoutMs}ms (model=${params.modelId}, pdfs=${params.pdfCount})`,
      );
      logPdfNativeFailure({
        provider: params.provider,
        modelId: params.modelId,
        pdfCount: params.pdfCount,
        timeoutMs,
        durationMs,
        error: timeoutError,
      });
      throw timeoutError;
    }
    logPdfNativeFailure({
      provider: params.provider,
      modelId: params.modelId,
      pdfCount: params.pdfCount,
      timeoutMs,
      durationMs,
      error,
    });
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Anthropic – native PDF via Messages API
// ---------------------------------------------------------------------------

type AnthropicDocBlock = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
};

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicContentBlock = AnthropicDocBlock | AnthropicTextBlock;

type AnthropicResponseContent = Array<{ type: string; text?: string }>;

export async function anthropicAnalyzePdf(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  pdfs: PdfInput[];
  maxTokens?: number;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Anthropic PDF: apiKey required");
  }

  const content: AnthropicContentBlock[] = [];
  for (const pdf of params.pdfs) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdf.base64,
      },
    });
  }
  content.push({ type: "text", text: params.prompt });

  const baseUrl = (params.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const nativeResponse = await fetchPdfNativeJson({
    provider: "anthropic",
    modelId: params.modelId,
    pdfCount: params.pdfs.length,
    timeoutMs: params.timeoutMs,
    url: `${baseUrl}/v1/messages`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
      },
      body: JSON.stringify({
        model: params.modelId,
        max_tokens: params.maxTokens ?? 4096,
        messages: [{ role: "user", content }],
      }),
    },
  });

  const responseContent = nativeResponse.json.content as AnthropicResponseContent | undefined;
  if (!Array.isArray(responseContent)) {
    const error = new Error("Anthropic PDF response missing content array.");
    logPdfNativeFailure({
      provider: "anthropic",
      modelId: params.modelId,
      pdfCount: params.pdfs.length,
      timeoutMs: nativeResponse.timeoutMs,
      durationMs: nativeResponse.durationMs,
      error,
    });
    throw error;
  }

  const text = responseContent
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");

  if (!text.trim()) {
    const error = new Error("Anthropic PDF returned no text.");
    logPdfNativeFailure({
      provider: "anthropic",
      modelId: params.modelId,
      pdfCount: params.pdfs.length,
      timeoutMs: nativeResponse.timeoutMs,
      durationMs: nativeResponse.durationMs,
      error,
    });
    throw error;
  }

  const trimmed = text.trim();
  logPdfNativeSuccess({
    provider: "anthropic",
    modelId: params.modelId,
    pdfCount: params.pdfs.length,
    timeoutMs: nativeResponse.timeoutMs,
    durationMs: nativeResponse.durationMs,
    textChars: trimmed.length,
  });
  return trimmed;
}

// ---------------------------------------------------------------------------
// Google Gemini – native PDF via generateContent API
// ---------------------------------------------------------------------------

type GeminiPart = { inline_data: { mime_type: string; data: string } } | { text: string };

type GeminiCandidate = {
  content?: { parts?: Array<{ text?: string }> };
};

export async function geminiAnalyzePdf(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  pdfs: PdfInput[];
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Gemini PDF: apiKey required");
  }

  const parts: GeminiPart[] = [];
  for (const pdf of params.pdfs) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: pdf.base64,
      },
    });
  }
  parts.push({ text: params.prompt });

  const transport = normalizeProviderTransportWithPlugin({
    provider: "google",
    context: {
      provider: "google",
      api: "google-generative-ai",
      baseUrl: params.baseUrl,
    },
  }) ?? { baseUrl: params.baseUrl };
  const baseUrl = (transport.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/v1beta$/i,
    "",
  );
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(params.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const nativeResponse = await fetchPdfNativeJson({
    provider: "google",
    modelId: params.modelId,
    pdfCount: params.pdfs.length,
    timeoutMs: params.timeoutMs,
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
      }),
    },
  });

  const candidates = nativeResponse.json.candidates as GeminiCandidate[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const error = new Error("Gemini PDF returned no candidates.");
    logPdfNativeFailure({
      provider: "google",
      modelId: params.modelId,
      pdfCount: params.pdfs.length,
      timeoutMs: nativeResponse.timeoutMs,
      durationMs: nativeResponse.durationMs,
      error,
    });
    throw error;
  }

  const textParts = candidates[0].content?.parts?.filter((p) => typeof p.text === "string") ?? [];
  const text = textParts.map((p) => p.text!).join("");

  if (!text.trim()) {
    const error = new Error("Gemini PDF returned no text.");
    logPdfNativeFailure({
      provider: "google",
      modelId: params.modelId,
      pdfCount: params.pdfs.length,
      timeoutMs: nativeResponse.timeoutMs,
      durationMs: nativeResponse.durationMs,
      error,
    });
    throw error;
  }

  const trimmed = text.trim();
  logPdfNativeSuccess({
    provider: "google",
    modelId: params.modelId,
    pdfCount: params.pdfs.length,
    timeoutMs: nativeResponse.timeoutMs,
    durationMs: nativeResponse.durationMs,
    textChars: trimmed.length,
  });
  return trimmed;
}
