export type SentMessageLookup = {
  text?: string;
  messageId?: string;
};

export type SentMessageCache = {
  remember: (scope: string, lookup: SentMessageLookup) => void;
  has: (scope: string, lookup: SentMessageLookup) => boolean;
};

const SENT_MESSAGE_TEXT_TTL_MS = 5000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;

function normalizeEchoTextKey(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function normalizeEchoMessageIdKey(messageId: string | undefined): string | null {
  if (!messageId) {
    return null;
  }
  const normalized = messageId.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

class DefaultSentMessageCache implements SentMessageCache {
  private textCache = new Map<string, number>();
  private messageIdCache = new Map<string, number>();

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      this.textCache.set(`${scope}:${textKey}`, Date.now());
    }
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
    }
    this.cleanup();
  }

  has(scope: string, lookup: SentMessageLookup): boolean {
    this.cleanup();
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
    }
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
      if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.textCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.textCache.delete(key);
      }
    }
    for (const [key, timestamp] of this.messageIdCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
