/**
 * Bounded set of recently sent messages used for echo detection.
 *
 * Instead of relying on a short TTL (which breaks when LLM inference exceeds the window),
 * this tracks sent text in a FIFO-bounded set with no time dependency.
 *
 * - `remember()` stores the scoped text; oldest entries are evicted when the set is full.
 * - `has()` checks for a match and removes it on hit (one-shot) so the same user text
 *   sent later is not falsely detected as an echo.
 */
export class SentMessageCache {
  private entries: Array<{ key: string }> = [];
  private index = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  remember(scope: string, text: string): void {
    if (!text?.trim()) {
      return;
    }
    const key = `${scope}:${text.trim()}`;
    if (this.index.has(key)) {
      return; // already tracked
    }
    this.entries.push({ key });
    this.index.add(key);
    while (this.entries.length > this.maxEntries) {
      const evicted = this.entries.shift();
      if (evicted) {
        this.index.delete(evicted.key);
      }
    }
  }

  has(scope: string, text: string): boolean {
    if (!text?.trim()) {
      return false;
    }
    const key = `${scope}:${text.trim()}`;
    if (!this.index.has(key)) {
      return false;
    }
    // One-shot: remove after match so user can later send the same text.
    this.index.delete(key);
    const idx = this.entries.findIndex((e) => e.key === key);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
    }
    return true;
  }
}
