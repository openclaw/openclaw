import { createHash } from "node:crypto";

function hashKey(scope: string, text: string): string {
  return createHash("sha256").update(`${scope}:${text.trim()}`).digest("base64url");
}

/**
 * Bounded set of recently sent message hashes used for echo detection.
 *
 * Bot-generated text is hashed on send; inbound text is hashed on arrival and
 * compared — if the hash exists the message is a bot echo.  No dependency on
 * `is_from_me`; pure content matching via SHA-256.
 *
 * One-shot removal on match so the same user text sent later is not falsely blocked.
 */
export class SentMessageCache {
  private entries: string[] = [];
  private index = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  remember(scope: string, text: string): void {
    if (!text?.trim()) {
      return;
    }
    const h = hashKey(scope, text);
    if (this.index.has(h)) {
      return;
    }
    this.entries.push(h);
    this.index.add(h);
    while (this.entries.length > this.maxEntries) {
      const evicted = this.entries.shift();
      if (evicted) {
        this.index.delete(evicted);
      }
    }
  }

  has(scope: string, text: string): boolean {
    if (!text?.trim()) {
      return false;
    }
    const h = hashKey(scope, text);
    if (!this.index.has(h)) {
      return false;
    }
    this.index.delete(h);
    const idx = this.entries.indexOf(h);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
    }
    return true;
  }
}
