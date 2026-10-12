import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  filterStringEntries,
  normalizeUniqueTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Context } from "../../llm/types.js";
import { renderDocumentTruncationNotice } from "../../media/document-extraction-metadata.js";
import type { PdfExtractedContent } from "../../media/pdf-extract.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { createMediaAssistantTextCoercer } from "./media-tool-text.js";

type PdfModelConfig = Exclude<AgentModelConfig, string>;

export function resolvePdfInputs(record: Record<string, unknown>): string[] {
  const pdfInputs = normalizeUniqueTrimmedStringList([
    record.pdf,
    ...filterStringEntries(record.pdfs),
  ]);
  if (pdfInputs.length === 0) {
    throw new Error("pdf required: provide a path or URL to a PDF document");
  }
  return pdfInputs;
}

function readPageNumber(value: string, errorLabel: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${errorLabel}: "${value}"`);
  }
  return parsed;
}

/** Parses a page range into at most `maxPages` sorted, unique, 1-based page numbers. */
export function parsePageRange(
  range: string,
  maxPages: number,
): { pages: number[]; truncated: boolean } {
  const ranges: [number, number][] = [];
  const parts = range.split(",").map((p) => p.trim());
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (dashMatch) {
      const start = readPageNumber(dashMatch[1] ?? "", "Invalid page range");
      const end = readPageNumber(dashMatch[2] ?? "", "Invalid page range");
      if (end < start) {
        throw new Error(`Invalid page range: "${part}"`);
      }
      ranges.push([start, end]);
    } else {
      if (!/^\d+$/.test(part)) {
        throw new Error(`Invalid page number: "${part}"`);
      }
      const num = readPageNumber(part, "Invalid page number");
      ranges.push([num, num]);
    }
  }
  ranges.sort(([left], [right]) => left - right);
  const pages: number[] = [];
  for (const [start, end] of ranges) {
    for (let page = Math.max(start, (pages.at(-1) ?? 0) + 1); page <= end; page++) {
      if (pages.length >= maxPages) {
        return { pages, truncated: true };
      }
      pages.push(page);
    }
  }
  if (pages.length === 0) {
    throw new Error(`No PDF pages matched requested range "${range}"`);
  }
  return { pages, truncated: false };
}

export const coercePdfAssistantText = createMediaAssistantTextCoercer("PDF");

export function coercePdfModelConfig(cfg?: OpenClawConfig): PdfModelConfig {
  const primary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.pdfModel);
  const fallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.pdfModel);
  const modelConfig: PdfModelConfig = {};
  if (primary?.trim()) {
    modelConfig.primary = primary.trim();
  }
  if (fallbacks.length > 0) {
    modelConfig.fallbacks = fallbacks;
  }
  return modelConfig;
}

export function resolvePdfToolMaxTokens(modelMaxTokens: number | undefined) {
  return Math.min(4096, asPositiveFiniteNumber(modelMaxTokens) ?? 4096);
}

const CODEX_PDF_INSTRUCTIONS =
  "Analyze the provided PDF content and answer the user's request accurately.";

export function buildPdfExtractionContext(
  prompt: string,
  extractions: PdfExtractedContent[],
  explicitSelectionLimit?: number,
  model?: { api?: string },
): Context {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];

  for (const [i, extraction] of extractions.entries()) {
    const notice = renderDocumentTruncationNotice(extraction.metadata, explicitSelectionLimit);
    if (extraction.text.trim() || notice) {
      const label = extractions.length > 1 ? `[PDF ${i + 1} text]\n` : "[PDF text]\n";
      const text = extraction.text.trim()
        ? wrapExternalContent(extraction.text, { source: "unknown", includeWarning: false })
        : undefined;
      content.push({
        type: "text",
        text: label + [notice, text].filter(Boolean).join("\n"),
      });
    }
    for (const img of extraction.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  content.push({ type: "text", text: prompt });

  const systemPrompt =
    model?.api === "openai-chatgpt-responses" ? CODEX_PDF_INSTRUCTIONS : undefined;

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: [{ role: "user", content, timestamp: Date.now() }],
  };
}
