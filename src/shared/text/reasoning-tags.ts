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

  return applyTrim(result, trimMode);
}

// --- Stateful streaming thinking-block filter ---
// Tracks whether the stream is inside a <think>/<thinking>/<thought>/<antthinking>
// block across incremental delta chunks, suppressing all content between the
// opening and closing tags (inclusive).

const OPEN_TAG_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/i;
const CLOSE_TAG_RE = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/i;

// Partial-tag detector: an incomplete `<...` at the end of a chunk that could
// be the start of a thinking tag split across two deltas.
const PARTIAL_OPEN_RE =
  /<\s*(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?|a(?:n(?:t(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?$/i;
const PARTIAL_CLOSE_RE =
  /<\s*\/\s*(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?|a(?:n(?:t(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?$/i;

export type StreamingThinkingFilter = {
  /** Process a delta chunk — returns the portion safe to emit (may be empty). */
  filter(delta: string): string;
  /** Reset state (e.g. when a run ends). */
  reset(): void;
};

export function createStreamingThinkingFilter(): StreamingThinkingFilter {
  let insideBlock = false;
  let pendingPartial = "";

  function filter(delta: string): string {
    const input = pendingPartial + delta;
    pendingPartial = "";

    if (!insideBlock) {
      // Look for an opening tag in this chunk.
      const openMatch = OPEN_TAG_RE.exec(input);
      if (openMatch) {
        insideBlock = true;
        const before = input.slice(0, openMatch.index);
        const after = input.slice(openMatch.index + openMatch[0].length);
        // Recurse to handle closing tag (or more opens) in the remainder.
        return before + filter(after);
      }
      // Check for a partial tag at the end that might complete in the next delta.
      const partialMatch = PARTIAL_OPEN_RE.exec(input);
      if (partialMatch && partialMatch[0].length > 0) {
        pendingPartial = partialMatch[0];
        return input.slice(0, partialMatch.index);
      }
      return input;
    }

    // Inside a thinking block — look for closing tag.
    const closeMatch = CLOSE_TAG_RE.exec(input);
    if (closeMatch) {
      insideBlock = false;
      const after = input.slice(closeMatch.index + closeMatch[0].length);
      // Recurse so further opens/text in the remainder are processed.
      return filter(after);
    }
    // Check for partial closing tag at the end.
    const partialClose = PARTIAL_CLOSE_RE.exec(input);
    if (partialClose && partialClose[0].length > 0) {
      pendingPartial = partialClose[0];
    }
    // Suppress everything while inside the block.
    return "";
  }

  function reset() {
    insideBlock = false;
    pendingPartial = "";
  }

  return { filter, reset };
}
