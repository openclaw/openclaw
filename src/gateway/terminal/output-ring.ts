// Bounded terminal scrollback storage shared by session lifecycle operations.

/**
 * Last `cap` chars of `chunk`, nudged forward one unit when the cut would land
 * mid-surrogate-pair: a replayed lone surrogate is permanent mojibake, unlike a
 * mid-escape cut the emulator repaints over.
 */
export function surrogateSafeTail(chunk: string, cap: number): string {
  const start = chunk.length - cap;
  const startsOnLowSurrogate =
    start > 0 &&
    chunk.charCodeAt(start) >= 0xdc00 &&
    chunk.charCodeAt(start) <= 0xdfff &&
    chunk.charCodeAt(start - 1) >= 0xd800 &&
    chunk.charCodeAt(start - 1) <= 0xdbff;
  return chunk.slice(startsOnLowSurrogate ? start + 1 : start);
}

/**
 * Raw output, not a screen snapshot: head truncation can start replay mid-escape,
 * and the emulator recovers on its next full repaint.
 */
export class TerminalOutputRing {
  private chunks: string[] = [];
  private total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    if (chunk.length >= this.cap) {
      const tail = surrogateSafeTail(chunk, this.cap);
      this.chunks = [tail];
      this.total = tail.length;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
    // Evict whole PTY writes so surviving data keeps its original boundaries.
    while (this.total > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift();
      if (!head) {
        break;
      }
      this.total -= head.length;
    }
  }

  snapshot(): string {
    return this.chunks.join("");
  }
}
