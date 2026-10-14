import {
  findGraphemeChunkEnd,
  skipWhitespaceGraphemes,
  trimEndWhitespaceGraphemes,
} from "@openclaw/normalization-core/grapheme";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

const CJK_PUNCTUATION_BREAK_AFTER_RE = /[、。，．！？；：）］｝〉》」』】〕〗〙]/u;

export function normalizeChunkLimit(limit: number): number {
  // String slicing truncates fractional indexes, so positive limits need an integer progress step.
  return Number.isFinite(limit) && limit > 0 ? resolveIntegerOption(limit, 1, { min: 1 }) : limit;
}

function findWhitespaceBreak(window: string): number {
  for (let index = window.length - 1; index >= 0; index--) {
    if (/\s/.test(window.charAt(index))) {
      return index;
    }
  }
  return -1;
}

function findCjkPunctuationBreak(window: string): number {
  for (let end = window.length; end > 1; end--) {
    if (CJK_PUNCTUATION_BREAK_AFTER_RE.test(window.charAt(end - 1))) {
      return end;
    }
  }
  return -1;
}

export function splitLongTextLine(
  line: string,
  limit: number,
  options: { preserveWhitespace: boolean },
): string[] {
  const normalizedLimit = normalizeChunkLimit(limit);
  if (normalizedLimit <= 0 || line.length <= normalizedLimit) {
    return [line];
  }
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > normalizedLimit) {
    let breakIndex = normalizedLimit;
    if (!options.preserveWhitespace) {
      const window = remaining.slice(0, normalizedLimit);
      breakIndex = findWhitespaceBreak(window);
      if (breakIndex <= 0) {
        breakIndex = findCjkPunctuationBreak(window);
      }
    }
    breakIndex = findGraphemeChunkEnd(remaining, 0, normalizedLimit, breakIndex);
    chunks.push(remaining.slice(0, breakIndex));
    remaining = remaining.slice(breakIndex);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Splits text into bounded chunks using caller-owned soft-break selection.
 *
 * The resolver sees each limit-sized window and returns an in-window break index;
 * invalid indexes fall back to the hard limit so chunking always makes progress.
 */
export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number,
): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = normalizeChunkLimit(limit);
  if (normalizedLimit <= 0 || text.length <= normalizedLimit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > normalizedLimit) {
    const window = remaining.slice(0, normalizedLimit);
    const safeBreakIdx = findGraphemeChunkEnd(
      remaining,
      0,
      normalizedLimit,
      resolveBreakIndex(window),
    );
    const chunk = trimEndWhitespaceGraphemes(remaining, safeBreakIdx);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    // Consume only complete disposable separators before the next window.
    remaining = remaining.slice(skipWhitespaceGraphemes(remaining, safeBreakIdx));
  }
  const finalChunk = trimEndWhitespaceGraphemes(remaining);
  if (finalChunk.length) {
    chunks.push(finalChunk);
  }
  return chunks;
}
