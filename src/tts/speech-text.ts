import { countMarkdownFencedCodeChars } from "../../packages/markdown-core/src/ir.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";

export const CODE_HEAVY_SPOKEN_FALLBACK = "I've put the detailed response on screen.";

// At least half fenced-code content is unlikely to produce useful speech after stripping.
// Keep the threshold deterministic so Talk clients and providers hear the same fallback.
const CODE_HEAVY_FENCED_CHAR_RATIO = 0.5;

export function isCodeHeavySpeechText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return countMarkdownFencedCodeChars(trimmed) / trimmed.length >= CODE_HEAVY_FENCED_CHAR_RATIO;
}

export function normalizeSpeechText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return stripMarkdown(trimmed, { linkStyle: "label", mode: "speech" }).trim();
}
