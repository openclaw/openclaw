import { findCodeRegions, isInsideCode } from "./code-regions.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

// Gemini 3.0 Flash sometimes outputs bare "thought" text markers without XML tags.
// This regex matches standalone "thought" text (case-insensitive, word boundary).
const BARE_THOUGHT_RE = /\bthought\b/gi;

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
  },
): string {
  if (!text) {
    return text;
  }
  // Quick check: skip processing if no XML reasoning tags OR bare "thought" markers present
  if (!QUICK_TAG_RE.test(text) && !BARE_THOUGHT_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";

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
      }
    } else if (isClose) {
      inThinking = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  // If no XML tags were processed, use the original cleaned text
  if (!result) {
    result = cleaned;
  }

  // Strip bare "thought" text markers that some models (e.g., Gemini 3.0 Flash) output
  // without XML tags. Only remove standalone "thought" words, not those inside code blocks.
  BARE_THOUGHT_RE.lastIndex = 0;
  if (BARE_THOUGHT_RE.test(result)) {
    const codeRegionsForBare = findCodeRegions(result);
    let resultWithoutBareThought = "";
    let lastIdx = 0;

    BARE_THOUGHT_RE.lastIndex = 0;
    for (const match of result.matchAll(BARE_THOUGHT_RE)) {
      const idx = match.index ?? 0;
      if (isInsideCode(idx, codeRegionsForBare)) {
        continue;
      }
      resultWithoutBareThought += result.slice(lastIdx, idx);
      lastIdx = idx + match[0].length;
    }
    resultWithoutBareThought += result.slice(lastIdx);
    result = resultWithoutBareThought;
  }

  return applyTrim(result, trimMode);
}
