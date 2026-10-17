import { BoundedBuffer } from "../../shared/bounded-buffer.js";

/**
 * Last `cap` chars of `chunk`, nudged forward one unit when the cut would land
 * mid-surrogate-pair: a replayed lone surrogate is permanent mojibake, unlike a
 * mid-escape cut the emulator repaints over.
 */
export function surrogateSafeTail(chunk: string, cap: number): string {
  const start = chunk.length - cap;
  const splitsPair =
    start > 0 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(chunk.slice(start - 1, start + 1));
  return chunk.slice(splitsPair ? start + 1 : start);
}

/** Page of raw output; offsets count UTF-16 code units since the session opened. */
export type TerminalOutputPage = {
  raw: string;
  startCursor: number;
  nextCursor: number;
  endCursor: number;
  truncated: boolean;
  hasMore: boolean;
};

export type TerminalOutputPageRequest = { cursor?: number; maxChars: number };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Page start, pulled back a unit when `offset` lands inside a pair so no page opens on a lone low surrogate. */
function pageStart(text: string, offset: number): number {
  return offset > 0 &&
    isLowSurrogate(text.charCodeAt(offset)) &&
    isHighSurrogate(text.charCodeAt(offset - 1))
    ? offset - 1
    : offset;
}

/**
 * Page end, kept off surrogate boundaries: a cut pair stays whole by shrinking the page,
 * and a page too small to carry one widens instead of emitting half a glyph.
 */
function pageEnd(text: string, start: number, maxChars: number): number {
  const end = Math.min(text.length, start + maxChars);
  if (
    end > start &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    return end - 1 > start ? end - 1 : Math.min(text.length, end + 1);
  }
  return end;
}

/** Raw output may start mid-escape after whole-write eviction; repaint recovers. */
export class TerminalOutputRing extends BoundedBuffer<string> {
  private writtenChars = 0;

  constructor(cap: number) {
    super(cap, { mode: "drop-oldest", fit: surrogateSafeTail }, (chunk) => chunk.length);
  }

  override push(chunk: string): boolean {
    const accepted = super.push(chunk);
    if (accepted) {
      this.writtenChars += chunk.length;
    }
    return accepted;
  }

  snapshot(): string {
    // Evicted slots are cleared, so joining with no separator skips that prefix without a copy.
    return this.values.join("");
  }

  /**
   * Page of retained output from `cursor` — the newest `maxChars` when the caller has none.
   * Cursors are cumulative over everything written, so they stay meaningful after eviction;
   * offsets refer to raw output, which the renderer may shorten.
   */
  readPage({ cursor, maxChars }: TerminalOutputPageRequest): TerminalOutputPage {
    const window = this.snapshot();
    const endCursor = this.writtenChars;
    const windowStart = endCursor - window.length;
    const requested = cursor ?? Math.max(windowStart, endCursor - maxChars);
    const from = Math.min(Math.max(requested, windowStart), endCursor);
    const start = pageStart(window, from - windowStart);
    const stop = pageEnd(window, start, maxChars);
    return {
      raw: window.slice(start, stop),
      startCursor: windowStart + start,
      nextCursor: windowStart + stop,
      endCursor,
      // Only a cursor below the retained window means the caller lost output it asked for.
      truncated: requested < windowStart,
      hasMore: windowStart + stop < endCursor,
    };
  }
}
