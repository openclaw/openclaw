/**
 * Direct SDK/HTTP calls for providers that support native PDF document input.
 * This bypasses pi-ai's content type system which does not have a "document" type.
 */

import { isRecord } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

type PdfInput = {
  base64: string;
  filename?: string;
};

type MistralOcrPage = {
  markdown?: string;
};

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
  const res = await fetch(`${baseUrl}/v1/messages`, {
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
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Anthropic PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`,
    );
  }

  const json = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    throw new Error("Anthropic PDF response was not JSON.");
  }

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

  const baseUrl = (params.baseUrl ?? "https://generativelanguage.googleapis.com").replace(
    /\/+$/,
    "",
  );
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(params.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gemini PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`,
    );
  }

  const json = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    throw new Error("Gemini PDF response was not JSON.");
  }

  const candidates = json.candidates as GeminiCandidate[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Gemini PDF returned no candidates.");
  }

  const textParts = candidates[0].content?.parts?.filter((p) => typeof p.text === "string") ?? [];
  const text = textParts.map((p) => p.text!).join("");

  if (!text.trim()) {
    throw new Error("Gemini PDF returned no text.");
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Mistral OCR – native PDF OCR via /v1/ocr API
// ---------------------------------------------------------------------------

export async function mistralOcrPdf(params: {
  apiKey: string;
  pdf: PdfInput;
  pageNumbers?: number[];
  modelId?: string;
  baseUrl?: string;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Mistral OCR: apiKey required");
  }

  const trimmedBaseUrl = (params.baseUrl ?? "https://api.mistral.ai").replace(/\/+$/, "");
  const url = /\/v1$/i.test(trimmedBaseUrl) ? `${trimmedBaseUrl}/ocr` : `${trimmedBaseUrl}/v1/ocr`;

  const zeroBasedPages =
    params.pageNumbers
      ?.map((page) => Math.floor(page) - 1)
      .filter((page) => Number.isFinite(page) && page >= 0) ?? [];
  const pages =
    zeroBasedPages.length > 0 ? Array.from(new Set(zeroBasedPages)).toSorted((a, b) => a - b) : [];

  const body: Record<string, unknown> = {
    model: params.modelId?.trim() || "mistral-ocr-latest",
    document: {
      type: "document_url",
      document_url: `data:application/pdf;base64,${params.pdf.base64}`,
    },
    include_image_base64: false,
  };
  if (pages.length > 0) {
    body.pages = pages;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new Error(
      `Mistral OCR request failed (${res.status} ${res.statusText})${responseBody ? `: ${responseBody.slice(0, 400)}` : ""}`,
    );
  }

  const json = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    throw new Error("Mistral OCR response was not JSON.");
  }

  const responsePages = json.pages as MistralOcrPage[] | undefined;
  if (!Array.isArray(responsePages)) {
    throw new Error("Mistral OCR response missing pages array.");
  }

  const text = responsePages
    .map((page) => (typeof page?.markdown === "string" ? page.markdown : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!text) {
    throw new Error("Mistral OCR returned no text.");
  }

  return text;
}
