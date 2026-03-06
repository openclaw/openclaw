import { createHash } from "node:crypto";

type SentMessageLookup = {
  text?: string;
  messageId?: string;
};

const SENT_MESSAGE_ID_TTL_MS = 60_000;

function hashTextKey(scope: string, text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return createHash("sha256").update(`${scope}:${normalized}`).digest("base64url");
}

function normalizeMessageId(messageId: string | undefined): string | null {
  if (!messageId) {
    return null;
  }
  const normalized = messageId.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

/**
 * Cache for echo detection.
 *
 * Text matching: SHA-256 hash with one-shot removal and no TTL — survives slow LLM inference.
 * MessageId matching: TTL-based (60s) for bridge-assigned message IDs.
 */
export class SentMessageCache {
  private textEntries: string[] = [];
  private textIndex = new Set<string>();
  private messageIdCache = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  remember(scope: string, lookup: SentMessageLookup): void {
    if (lookup.text?.trim()) {
      const h = hashTextKey(scope, lookup.text);
      if (!this.textIndex.has(h)) {
        this.textEntries.push(h);
        this.textIndex.add(h);
        while (this.textEntries.length > this.maxEntries) {
          const evicted = this.textEntries.shift();
          if (evicted) {
            this.textIndex.delete(evicted);
          }
        }
      }
    }
    const messageIdKey = normalizeMessageId(lookup.messageId);
    if (messageIdKey) {
      this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
      this.cleanupMessageIds();
    }
  }

  has(scope: string, lookup: SentMessageLookup): boolean {
    const messageIdKey = normalizeMessageId(lookup.messageId);
    if (messageIdKey) {
      const timestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      if (timestamp !== undefined && Date.now() - timestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
    }
    if (lookup.text?.trim()) {
      const h = hashTextKey(scope, lookup.text);
      if (this.textIndex.has(h)) {
        this.textIndex.delete(h);
        const idx = this.textEntries.indexOf(h);
        if (idx >= 0) {
          this.textEntries.splice(idx, 1);
        }
        return true;
      }
    }
    return false;
  }

  private cleanupMessageIds(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.messageIdCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
  }
}
