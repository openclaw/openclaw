import { chunkMarkdownTextWithMode, type ChunkMode } from "../auto-reply/chunk.js";

export type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 2000. */
  maxChars?: number;
  /**
   * Soft max line count per message. Default: 17.
   *
   * Discord clients can clip/collapse very tall messages in the UI; splitting
   * by lines keeps long multi-paragraph replies readable.
   */
  maxLines?: number;
};

type OpenFence = {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Regex matching CJK punctuation marks that serve as natural sentence or
 * clause boundaries.  Splitting at these positions keeps CJK text readable
 * because they are equivalent to periods, commas, exclamation marks, etc.
 *
 * Included ranges:
 *   U+3000-U+303F  CJK Symbols and Punctuation (。、〃〈〉《》「」『』【】〔〕〖〗…)
 *   U+FF01-U+FF0F  Fullwidth ASCII variants (！＂＃＄％＆＇（）＊＋，－．／)
 *   U+FF1A-U+FF1F  Fullwidth colon–question mark (：；＜＝＞？)
 *   U+FF3B-U+FF3D  Fullwidth brackets (［＼］)
 *   U+FF5B-U+FF65  Fullwidth braces and halfwidth Katakana punctuation
 */
const CJK_PUNCTUATION_RE = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF1F\uFF3B-\uFF3D\uFF5B-\uFF65]/;

/**
 * Regex matching CJK ideograph characters.  CJK text has no word-separating
 * spaces, so any boundary between two CJK characters is a valid (though less
 * ideal) split point when no punctuation is available.
 *
 * Included ranges:
 *   U+4E00-U+9FFF   CJK Unified Ideographs
 *   U+3400-U+4DBF   CJK Unified Ideographs Extension A
 *   U+F900-U+FAFF   CJK Compatibility Ideographs
 *   U+3040-U+309F   Hiragana
 *   U+30A0-U+30FF   Katakana
 *   U+AC00-U+D7AF   Hangul Syllables
 */
const CJK_CHAR_RE =
  /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

function countLines(text: string) {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null) {
  if (!openFence) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}\n${closeLine}`;
  }
  return `${text}${closeLine}`;
}

/**
 * Find the best break index within `window` for CJK-aware text splitting.
 *
 * Priority order:
 *   1. Whitespace (original behaviour — works for Latin/mixed text)
 *   2. CJK punctuation (。！？，、；：etc.) — natural clause boundaries
 *   3. Any CJK character boundary — still readable because each character
 *      is an independent ideograph / syllable
 *
 * Returns -1 when no suitable break point is found.
 */
function findBreakIndex(window: string): number {
  let whitespaceIdx = -1;
  let cjkPunctuationIdx = -1;
  let cjkCharIdx = -1;

  for (let i = window.length - 1; i >= 0; i--) {
    const ch = window[i];
    if (whitespaceIdx < 0 && /\s/.test(ch)) {
      whitespaceIdx = i;
      // Whitespace is the best break point — return immediately.
      break;
    }
    if (cjkPunctuationIdx < 0 && CJK_PUNCTUATION_RE.test(ch)) {
      // Apply the same minimum-progress guard as the CJK character fallback
      // to avoid producing tiny chunks (e.g., "链接：" before a long URL).
      if (i + 1 > window.length * 0.2) {
        cjkPunctuationIdx = i;
      }
    }
    if (cjkCharIdx < 0 && CJK_CHAR_RE.test(ch)) {
      // Split *after* the CJK character so it stays with the current chunk.
      // Only accept it if it provides reasonable progress (e.g., > 20% of window)
      // to avoid splitting right before a long ASCII token (like a URL).
      if (i + 1 > window.length * 0.2) {
        cjkCharIdx = i + 1;
      }
    }
  }

  // Prefer whitespace > CJK punctuation > CJK character boundary.
  if (whitespaceIdx > 0) {
    return whitespaceIdx;
  }
  // Split after the punctuation mark so it stays with the preceding clause.
  if (cjkPunctuationIdx > 0 && cjkPunctuationIdx + 1 < window.length) {
    return cjkPunctuationIdx + 1;
  }
  if (cjkCharIdx > 0 && cjkCharIdx < window.length) {
    return cjkCharIdx;
  }
  return -1;
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { preserveWhitespace: boolean },
): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (line.length <= limit) {
    return [line];
  }
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > limit) {
    if (opts.preserveWhitespace) {
      out.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }
    const window = remaining.slice(0, limit);
    const breakIdx = findBreakIndex(window);
    if (breakIdx <= 0) {
      // No suitable break point found — hard split at the limit.
      out.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    } else {
      out.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx);
    }
  }
  if (remaining.length) {
    out.push(remaining);
  }
  return out;
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

  const lines = body.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
    current = "";
    currentLines = 0;
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
    }
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
    const reserveLines = nextOpenFence ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - prefixLen);
    const segments = splitLongLine(originalLine, segmentLimit, {
      preserveWhitespace: wasInsideFence,
    });

    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex];
      const isLineContinuation = segIndex > 0;
      const delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
      const addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation) {
          currentLines += 1;
        }
      } else {
        current = segment;
        currentLines = 1;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
  }

  return rebalanceReasoningItalics(text, chunks);
}

export function chunkDiscordTextWithMode(
  text: string,
  opts: ChunkDiscordTextOpts & { chunkMode?: ChunkMode },
): string[] {
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)),
    "newline",
  );
  const chunks: string[] = [];
  for (const line of lineChunks) {
    const nested = chunkDiscordText(line, opts);
    if (!nested.length && line) {
      chunks.push(line);
      continue;
    }
    chunks.push(...nested);
  }
  return chunks;
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next so every chunk renders
// consistently.
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const opensWithReasoningItalics =
    source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_");
  if (!opensWithReasoningItalics) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = adjusted[i];

    // Ensure current chunk closes italics so Discord renders it italicized.
    const needsClosing = !current.trimEnd().endsWith("_");
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    // Re-open italics on the next chunk if needed.
    const next = adjusted[i + 1];
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (!nextBody.startsWith("_")) {
      adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
    }
  }

  return adjusted;
}
