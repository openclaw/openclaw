/**
 * [[SPLIT]] directive — splits assistant output into separate delivery segments.
 * Each segment becomes a separate WhatsApp bubble with a human-like delay between them.
 *
 * Rules:
 * - Case-insensitive, optional whitespace inside brackets: `[[ split ]]`, `[[SPLIT]]`
 * - Skipped inside fenced code blocks (``` ... ```) and inline code (`...`)
 * - Empty segments after trimming are dropped
 */

export const SPLIT_TAG_RE = /\[\[\s*split\s*\]\]/gi;

/**
 * Split text on `[[SPLIT]]` directives, respecting code fences and inline code.
 * Returns an array of trimmed, non-empty segments.
 * If no split tags are found (or all are inside code), returns the original text as a single-element array.
 */
export function splitOnSplitTags(text: string): string[] {
  if (!text || !SPLIT_TAG_RE.test(text)) {
    return text ? [text] : [];
  }
  // Reset regex lastIndex after test()
  SPLIT_TAG_RE.lastIndex = 0;

  // Build a set of character ranges that are inside code (fenced or inline)
  const codeRanges = getCodeRanges(text);

  // Walk through all [[SPLIT]] matches, only split on those outside code ranges
  const splitIndices: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = SPLIT_TAG_RE.exec(text)) !== null) {
    if (!isInsideRanges(match.index, codeRanges)) {
      splitIndices.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  if (splitIndices.length === 0) {
    return [text];
  }

  const segments: string[] = [];
  let lastEnd = 0;
  for (const { start, end } of splitIndices) {
    const segment = text.slice(lastEnd, start).trim();
    if (segment) {
      segments.push(segment);
    }
    lastEnd = end;
  }
  // Trailing segment after last split tag
  const trailing = text.slice(lastEnd).trim();
  if (trailing) {
    segments.push(trailing);
  }

  return segments.length > 0 ? segments : text.trim() ? [text.trim()] : [];
}

/** Strip all [[SPLIT]] tags from text (for display/logging). */
export function stripSplitTags(text: string): string {
  return text
    .replace(SPLIT_TAG_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Internal helpers ---

type Range = { start: number; end: number };

/** Find all code ranges (fenced blocks and inline code) in text. */
function getCodeRanges(text: string): Range[] {
  const ranges: Range[] = [];

  // Fenced code blocks: ``` or ~~~
  const fenceRe = /^(`{3,}|~{3,}).*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let openFence: { marker: string; start: number } | undefined;

  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    const marker = fenceMatch[1];
    const firstChar = marker?.[0];
    if (!firstChar) {
      continue;
    }
    if (!openFence) {
      openFence = { marker: firstChar, start: fenceMatch.index };
    } else if (firstChar === openFence.marker && marker.length >= openFence.marker.length) {
      ranges.push({ start: openFence.start, end: fenceMatch.index + fenceMatch[0].length });
      openFence = undefined;
    }
  }
  // Unclosed fence extends to end of text
  if (openFence) {
    ranges.push({ start: openFence.start, end: text.length });
  }

  // Inline code: `...` (not inside fenced blocks)
  const inlineRe = /`([^`\n]+)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRe.exec(text)) !== null) {
    if (!isInsideRanges(inlineMatch.index, ranges)) {
      ranges.push({ start: inlineMatch.index, end: inlineMatch.index + inlineMatch[0].length });
    }
  }

  return ranges;
}

function isInsideRanges(index: number, ranges: Range[]): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}
