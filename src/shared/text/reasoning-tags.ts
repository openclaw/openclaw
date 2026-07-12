import { expectDefined } from "@openclaw/normalization-core";
// Reasoning tag helpers find and remove model reasoning tag blocks from text.
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { findFinalTagMatches } from "./final-tags.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";
export type ReasoningTagScope = "all" | "leading";

// Reasoning tags may carry a model-specific namespace prefix (e.g. Anthropic's
// `antml:`, MiniMax's `mm:`). Accept the known prefixes so namespaced variants
// like `<mm:think>` are stripped instead of leaking into visible output.
const QUICK_TAG_RE = /<\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking|final)\b/i;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
}

/** Detects whether a stray reasoning close tag separates two visible text regions. */
export function hasOrphanReasoningCloseBoundary(params: {
  before: string;
  after: string;
}): boolean {
  return params.before.trim().length > 0 && params.after.trim().length > 0;
}

function hasReasoningCloseTagAfter(
  text: string,
  start: number,
  codeRegions: ReturnType<typeof findCodeRegions>,
) {
  for (const match of text.slice(start).matchAll(THINKING_TAG_RE)) {
    const idx = start + (match.index ?? 0);
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }
    if (match[1] === "/") {
      return true;
    }
  }
  THINKING_TAG_RE.lastIndex = 0;
  return false;
}

/** Strips model reasoning/final tags from visible text while preserving literal code examples. */
export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
    scope?: ReasoningTagScope;
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
  const scope = options?.scope ?? "all";

  let cleaned = text;
  const matches = findFinalTagMatches(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  const hasThinkingTag = THINKING_TAG_RE.test(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  if (matches.length === 0 && !hasThinkingTag) {
    return text;
  }
  if (matches.length > 0) {
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of matches) {
      const start = match.index;
      finalMatches.push({
        start,
        length: match.text.length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = expectDefined(finalMatches[i], "final matches capture group i");
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let thinkingDepth = 0;
  let firstUnclosedContentIndex: number | undefined;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (thinkingDepth === 0) {
      if (
        scope === "leading" &&
        !isClose &&
        (result + cleaned.slice(lastIndex, idx)).trim().length > 0 &&
        !hasReasoningCloseTagAfter(cleaned, idx + match[0].length, codeRegions)
      ) {
        return applyTrim(result + cleaned.slice(lastIndex), trimMode);
      }
      if (isClose) {
        const afterIndex = idx + match[0].length;
        const before = cleaned.slice(lastIndex, idx);
        const after = cleaned.slice(afterIndex);
        if (hasOrphanReasoningCloseBoundary({ before, after })) {
          // A lone close tag after visible preamble means the hidden opening tag was
          // probably truncated; drop the preamble so partial reasoning is not leaked.
          result = "";
        } else {
          result += before;
        }
        lastIndex = afterIndex;
        continue;
      }
      result += cleaned.slice(lastIndex, idx);
      thinkingDepth = 1;
      firstUnclosedContentIndex = idx + match[0].length;
    } else if (isClose) {
      thinkingDepth -= 1;
      if (thinkingDepth === 0) {
        firstUnclosedContentIndex = undefined;
      }
    } else {
      thinkingDepth += 1;
    }

    lastIndex = idx + match[0].length;
  }

  if (thinkingDepth === 0 || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  if (
    mode === "strict" &&
    thinkingDepth > 0 &&
    !trimmedResult &&
    firstUnclosedContentIndex !== undefined &&
    cleaned.trim()
  ) {
    return applyTrim(cleaned.slice(firstUnclosedContentIndex), trimMode);
  }

  return trimmedResult;
}

/**
 * Strip plain-text reasoning blocks that bypass XML tag filtering.
 *
 * Detects `Reasoning:\n` (colon + newline) at the start of text or after blank lines,
 * and removes everything until the next paragraph break followed by a non-italic line,
 * or end-of-text.
 *
 * `Reasoning: inline text` (colon + space + same-line content) is NOT stripped
 * to avoid false positives on legitimate use of the word.
 *
 * Content inside fenced/inline code blocks is protected.
 */
export function stripPlainTextReasoningBlock(text: string): string {
  if (!text) {
    return text;
  }

  // Quick check: must contain "Reasoning:" followed by a newline somewhere
  if (!text.includes("Reasoning:\n")) {
    return text;
  }

  const codeRegions = findCodeRegions(text);

  // Match "Reasoning:\n" that is either at the start of text or preceded by a newline
  const pattern = /(?:^|\n)(Reasoning:\n)/g;

  // Collect all valid (non-code) reasoning block ranges
  const blocks: Array<{ start: number; end: number }> = [];

  for (const match of text.matchAll(pattern)) {
    const fullMatchStart = match.index;
    // The "Reasoning:\n" portion starts after the optional \n prefix
    const reasoningStart = fullMatchStart + match[0].length - match[1].length;

    if (isInsideCode(reasoningStart, codeRegions)) {
      continue;
    }

    // Find the end of this reasoning block.
    // Block ends at: \n\n followed by a non-italic line (not starting with _)
    // or at end of text.
    // NOTE: The italic continuation heuristic (?!_) is coupled with
    // formatReasoningMessage() which wraps reasoning lines in _..._.
    const afterHeader = reasoningStart + match[1].length; // position after "Reasoning:\n"
    const rest = text.slice(afterHeader);
    const endPattern = /\n\n(?!_)/g;
    let blockEnd = text.length; // default: rest of text

    for (const endMatch of rest.matchAll(endPattern)) {
      // blockEnd is the absolute position past the \n\n delimiter
      blockEnd = afterHeader + endMatch.index + 2;
      break;
    }

    blocks.push({ start: reasoningStart, end: blockEnd });
  }

  if (blocks.length === 0) {
    return text;
  }

  // Merge overlapping blocks (shouldn't normally happen, but be safe)
  const merged: Array<{ start: number; end: number }> = [blocks[0]];
  for (let i = 1; i < blocks.length; i++) {
    const prev = merged[merged.length - 1];
    if (blocks[i].start <= prev.end) {
      prev.end = Math.max(prev.end, blocks[i].end);
    } else {
      merged.push(blocks[i]);
    }
  }

  // Build result by skipping the merged block ranges
  let result = "";
  let cursor = 0;
  for (const block of merged) {
    result += text.slice(cursor, block.start);
    cursor = block.end;
  }
  result += text.slice(cursor);

  return applyTrim(result, "both");
}
