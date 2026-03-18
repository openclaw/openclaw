import { findCodeRegions, isInsideCode } from "./code-regions.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
}

export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
    /** When true, an unclosed `<think>` after non-empty content is treated as
     *  literal text rather than a reasoning block start. Use for final/complete
     *  text; leave false for streaming partials where an unclosed tag is normal. */
    finalText?: boolean;
  },
): string {
  if (!text) {
    return text;
  }
  if (!QUICK_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  const finalText = options?.finalText ?? false;

  let cleaned = text;
  if (FINAL_TAG_RE.test(cleaned)) {
    FINAL_TAG_RE.lastIndex = 0;
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
      const start = match.index ?? 0;
      finalMatches.push({
        start,
        length: match[0].length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = finalMatches[i];
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  } else {
    FINAL_TAG_RE.lastIndex = 0;
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  // Track position of the last unclosed opening tag so we can restore it when
  // the tag is a literal mention in final text (no closing tag follows).
  let unclosedOpenTagStart = -1;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (!inThinking) {
      result += cleaned.slice(lastIndex, idx);
      if (!isClose) {
        inThinking = true;
        unclosedOpenTagStart = idx;
      }
    } else if (isClose) {
      inThinking = false;
      unclosedOpenTagStart = -1;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  } else if (finalText && result.trim().length > 0 && unclosedOpenTagStart >= 0) {
    // In final text: an unclosed <think> that appears after meaningful content
    // is a literal mention, not a reasoning block. Restore the tag and trailing text.
    result += cleaned.slice(unclosedOpenTagStart);
  }

  return applyTrim(result, trimMode);
}
