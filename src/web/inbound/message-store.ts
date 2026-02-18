import type { proto } from "@whiskeysockets/baileys";

type StoredMessage = {
  chatJid: string;
  messageId: string;
  message: proto.IWebMessageInfo;
  timestamp: number;
};

class MessageStore {
  private messages = new Map<string, StoredMessage>();
  private messagesByChat = new Map<string, Set<string>>();
  private maxMessages = 1000; // Keep last 1000 messages
  private maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

  private makeKey(chatJid: string, messageId: string): string {
    return `${chatJid}:${messageId}`;
  }

  store(chatJid: string, messageId: string, message: proto.IWebMessageInfo): void {
    const key = this.makeKey(chatJid, messageId);
    this.messages.set(key, {
      chatJid,
      messageId,
      message,
      timestamp: Date.now(),
    });

    // Track messages by chat
    if (!this.messagesByChat.has(chatJid)) {
      this.messagesByChat.set(chatJid, new Set());
    }
    this.messagesByChat.get(chatJid)!.add(key);

    // Cleanup old messages if we exceed the limit
    if (this.messages.size > this.maxMessages) {
      this.cleanup();
    }
  }

  get(chatJid: string, messageId: string): proto.IWebMessageInfo | null {
    const key = this.makeKey(chatJid, messageId);
    const stored = this.messages.get(key);

    if (!stored) {
      return null;
    }

    // Check if message is too old
    if (Date.now() - stored.timestamp > this.maxAgeMs) {
      this.messages.delete(key);
      this.messagesByChat.get(chatJid)?.delete(key);
      return null;
    }

    return stored.message;
  }

  getMessagesForChat(chatJid: string, limit?: number): StoredMessage[] {
    const keys = this.messagesByChat.get(chatJid);
    if (!keys) {
      return [];
    }

    const now = Date.now();
    const messages: StoredMessage[] = [];

    for (const key of keys) {
      const stored = this.messages.get(key);
      if (!stored) continue;

      // Skip expired messages
      if (now - stored.timestamp > this.maxAgeMs) {
        this.messages.delete(key);
        keys.delete(key);
        continue;
      }

      messages.push(stored);
    }

    // Sort by timestamp (newest first)
    messages.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    if (limit && limit > 0) {
      return messages.slice(0, limit);
    }

    return messages;
  }

  private cleanup(): void {
    const now = Date.now();
    const entries = Array.from(this.messages.entries());

    // Sort by timestamp (oldest first)
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove old messages first
    for (const [key, stored] of entries) {
      if (now - stored.timestamp > this.maxAgeMs) {
        this.messages.delete(key);
        this.messagesByChat.get(stored.chatJid)?.delete(key);
      }
    }

    // If still over limit, remove oldest messages
    if (this.messages.size > this.maxMessages) {
      const toRemove = this.messages.size - this.maxMessages;
      let removed = 0;
      for (const [key, stored] of entries) {
        if (removed >= toRemove) break;
        if (this.messages.has(key)) {
          this.messages.delete(key);
          this.messagesByChat.get(stored.chatJid)?.delete(key);
          removed++;
        }
      }
    }

    // Clean up empty chat sets
    for (const [chatJid, keys] of this.messagesByChat.entries()) {
      if (keys.size === 0) {
        this.messagesByChat.delete(chatJid);
      }
    }
  }

  clear(): void {
    this.messages.clear();
    this.messagesByChat.clear();
  }

  size(): number {
    return this.messages.size;
  }

  // Debug helper: get all stored chat JIDs
  getStoredChats(): string[] {
    return Array.from(this.messagesByChat.keys());
  }

  // Debug helper: get message count per chat
  getStats(): {
    totalMessages: number;
    chatCount: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  } {
    const now = Date.now();
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const stored of this.messages.values()) {
      if (now - stored.timestamp <= this.maxAgeMs) {
        if (oldest === null || stored.timestamp < oldest) {
          oldest = stored.timestamp;
        }
        if (newest === null || stored.timestamp > newest) {
          newest = stored.timestamp;
        }
      }
    }

    return {
      totalMessages: this.messages.size,
      chatCount: this.messagesByChat.size,
      oldestTimestamp: oldest,
      newestTimestamp: newest,
    };
  }
}

// Global message store per account
const stores = new Map<string, MessageStore>();

export function getMessageStore(accountId: string): MessageStore {
  let store = stores.get(accountId);
  if (!store) {
    store = new MessageStore();
    stores.set(accountId, store);
  }
  return store;
}

export function clearMessageStore(accountId: string): void {
  stores.delete(accountId);
}
