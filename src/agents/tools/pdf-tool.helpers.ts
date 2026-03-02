import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import { extractAssistantText } from "../pi-embedded-utils.js";

export type PdfModelConfig = { primary?: string; fallbacks?: string[] };

/**
 * Providers known to support native PDF document input.
 * When the model's provider is in this set, the tool sends raw PDF bytes
 * via provider-specific API calls instead of extracting text/images first.
 */
export const NATIVE_PDF_PROVIDERS = new Set(["anthropic", "google"]);

/**
 * Check whether a provider supports native PDF document input.
 */
export function providerSupportsNativePdf(provider: string): boolean {
  return NATIVE_PDF_PROVIDERS.has(provider.toLowerCase().trim());
}

/**
 * Parse a page range string (e.g. "1-5", "3", "1-3,7-9") into an array of 1-based page numbers.
 */
export function parsePageRange(range: string, maxPages: number): number[] {
  const pages = new Set<number>();
  const parts = range.split(",").map((p) => p.trim());
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (dashMatch) {
      const start = Number(dashMatch[1]);
      const end = Number(dashMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range: "${part}"`);
      }
      for (let i = start; i <= Math.min(end, maxPages); i++) {
        pages.add(i);
      }
    } else {
      const num = Number(part);
      if (!Number.isFinite(num) || num < 1) {
        throw new Error(`Invalid page number: "${part}"`);
      }
      if (num <= maxPages) {
        pages.add(num);
      }
    }
  }
  return Array.from(pages).toSorted((a, b) => a - b);
}

export function coercePdfAssistantText(params: {
  message: AssistantMessage;
  provider: string;
  model: string;
}): string {
  const stop = params.message.stopReason;
  const errorMessage = params.message.errorMessage?.trim();
  if (stop === "error" || stop === "aborted") {
    throw new Error(
      errorMessage
        ? `PDF model failed (${params.provider}/${params.model}): ${errorMessage}`
        : `PDF model failed (${params.provider}/${params.model})`,
    );
  }
  if (errorMessage) {
    throw new Error(`PDF model failed (${params.provider}/${params.model}): ${errorMessage}`);
  }
  const text = extractAssistantText(params.message);
  if (text.trim()) {
    return text.trim();
  }
  throw new Error(`PDF model returned no text (${params.provider}/${params.model}).`);
}

export function coercePdfModelConfig(cfg?: OpenClawConfig): PdfModelConfig {
  const primary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.pdfModel);
  const fallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.pdfModel);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

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
