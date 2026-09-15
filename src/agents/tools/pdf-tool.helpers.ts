/**
 * PDF tool parsing and response helpers.
 *
 * Normalizes PDF inputs, page ranges, provider native support, model config, and assistant text output.
 */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantMessage } from "../../llm/types.js";
import { providerSupportsNativePdfDocument } from "../../media-understanding/defaults.js";
import { extractEmbeddedAssistantText } from "../embedded-agent-utils.js";

/** Normalized PDF model preference used by tool registration and execution. */
type PdfModelConfig = { primary?: string; fallbacks?: string[] };

/** Reads `pdf` and `pdfs` tool arguments into a trimmed, de-duplicated PDF input list. */
export function resolvePdfInputs(record: Record<string, unknown>): string[] {
  const pdfCandidates: string[] = [];
  if (typeof record.pdf === "string") {
    pdfCandidates.push(record.pdf);
  }
  if (Array.isArray(record.pdfs)) {
    pdfCandidates.push(...record.pdfs.filter((v): v is string => typeof v === "string"));
  }

  const seenPdfs = new Set<string>();
  const pdfInputs: string[] = [];
  for (const candidate of pdfCandidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seenPdfs.has(trimmed)) {
      continue;
    }
    seenPdfs.add(trimmed);
    pdfInputs.push(trimmed);
  }
  if (pdfInputs.length === 0) {
    throw new Error("pdf required: provide a path or URL to a PDF document");
  }
  return pdfInputs;
}

/** Checks whether a provider supports native PDF document input. */
export function providerSupportsNativePdf(provider: string): boolean {
  return providerSupportsNativePdfDocument({ providerId: provider });
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

/** Converts a provider assistant message into PDF text or throws a model-labelled failure. */
export function coercePdfAssistantText(params: {
  message: AssistantMessage;
  provider: string;
  model: string;
}): string {
  const label = `${params.provider}/${params.model}`;
  const errorMessage = params.message.errorMessage?.trim();
  const fail = (message?: string) => {
    throw new Error(
      message ? `PDF model failed (${label}): ${message}` : `PDF model failed (${label})`,
    );
  };
  if (params.message.stopReason === "error" || params.message.stopReason === "aborted") {
    fail(errorMessage);
  }
  if (errorMessage) {
    fail(errorMessage);
  }
  const text = extractEmbeddedAssistantText(params.message);
  const trimmed = text.trim();
  if (trimmed) {
    return trimmed;
  }
  throw new Error(`PDF model returned no text (${label}).`);
}

/** Reads configured PDF primary/fallback models from agent defaults. */
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

/** Caps requested PDF response tokens to the selected model's advertised maximum. */
export function resolvePdfToolMaxTokens(
  modelMaxTokens: number | undefined,
  requestedMaxTokens = 4096,
) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}
