/**
 * In-memory ring buffer of inbound Telegram messages per chat.
 *
 * Messages are recorded as they flow through the bot handler pipeline,
 * enabling chat history reads without calling getUpdates (which conflicts
 * with the running long-poll loop and doesn't support per-chat retrieval).
 *
 * Design mirrors sent-message-cache.ts: lightweight, in-memory, TTL-based
 * eviction, no disk persistence. Messages are available only while the
 * process is running — this is intentional to avoid storing user content
 * on disk without explicit opt-in.
 */

import type { Message } from "@grammyjs/types";

/** Maximum messages retained per chat. */
const DEFAULT_MAX_PER_CHAT = 200;

/** Messages older than this are evicted on next access. */
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Normalized message stored in the ring buffer. */
export interface StoredMessage {
  messageId: number;
  chatId: number;
  date: number; // Unix timestamp from Telegram
  storedAt: number; // Date.now() for TTL
  from?: {
    id: number;
    firstName?: string;
    lastName?: string;
    username?: string;
    isBot: boolean;
  };
  text?: string;
  caption?: string;
  replyToMessageId?: number;
}

type ChatBuffer = {
  messages: StoredMessage[];
  /** Set of message IDs for O(1) dedup. */
  seen: Set<number>;
};

const store = new Map<string, ChatBuffer>();

let maxPerChat = DEFAULT_MAX_PER_CHAT;

function chatKey(chatId: number | string): string {
  return String(chatId);
}

/** Extract the fields we need — nothing more. Minimizes retained data. */
function normalize(msg: Message): StoredMessage {
  return {
    messageId: msg.message_id,
    chatId: msg.chat.id,
    date: msg.date,
    storedAt: Date.now(),
    from: msg.from
      ? {
          id: msg.from.id,
          firstName: msg.from.first_name,
          lastName: msg.from.last_name,
          username: msg.from.username,
          isBot: msg.from.is_bot,
        }
      : undefined,
    text: msg.text,
    caption: msg.caption,
    replyToMessageId: msg.reply_to_message?.message_id,
  };
}

function evictExpired(buf: ChatBuffer): void {
  const cutoff = Date.now() - TTL_MS;
  let i = 0;
  while (i < buf.messages.length && buf.messages[i].storedAt < cutoff) {
    buf.seen.delete(buf.messages[i].messageId);
    i++;
  }
  if (i > 0) {
    buf.messages.splice(0, i);
  }
}

/**
 * Record an inbound message. Call from the bot handler pipeline.
 * Ignores duplicates (same message_id in same chat).
 */
export function recordInboundMessage(msg: Message): void {
  const key = chatKey(msg.chat.id);
  let buf = store.get(key);
  if (!buf) {
    buf = { messages: [], seen: new Set() };
    store.set(key, buf);
  }

  // Dedup — media groups and edits can trigger multiple handler calls
  if (buf.seen.has(msg.message_id)) {
    return;
  }

  buf.messages.push(normalize(msg));
  buf.seen.add(msg.message_id);

  // Evict oldest if over capacity
  while (buf.messages.length > maxPerChat) {
    const evicted = buf.messages.shift();
    if (evicted) {
      buf.seen.delete(evicted.messageId);
    }
  }
}

export interface ReadOptions {
  limit?: number;
  before?: number; // message_id — return messages before this
  after?: number; // message_id — return messages after this
}

/**
 * Read messages from the inbound store for a given chat.
 * Returns newest-first (consistent with Discord's readMessages).
 */
export function readInboundMessages(
  chatId: string | number,
  opts: ReadOptions = {},
): StoredMessage[] {
  const key = chatKey(chatId);
  const buf = store.get(key);
  if (!buf) {
    return [];
  }

  evictExpired(buf);

  let filtered = buf.messages;

  if (opts.before != null) {
    filtered = filtered.filter((m) => m.messageId < opts.before!);
  }
  if (opts.after != null) {
    filtered = filtered.filter((m) => m.messageId > opts.after!);
  }

  const limit = opts.limit != null ? Math.min(Math.max(Math.floor(opts.limit), 1), 100) : 50;

  // Return newest first — slice from end
  const sliced = filtered.slice(-limit);
  sliced.reverse();
  return sliced;
}

/** Number of chats currently tracked. */
export function inboundStoreStats(): { chatCount: number; totalMessages: number } {
  let totalMessages = 0;
  for (const buf of store.values()) {
    totalMessages += buf.messages.length;
  }
  return { chatCount: store.size, totalMessages };
}

/** Configure max messages per chat (for testing or config). */
export function setMaxPerChat(n: number): void {
  maxPerChat = Math.max(n, 10);
}

/** Clear all stored messages (for testing). */
export function clearInboundStore(): void {
  store.clear();
}
