// Bounded terminal scrollback storage shared by session lifecycle operations.
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
      this.chunks = [chunk.slice(chunk.length - this.cap)];
      this.total = this.cap;
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
