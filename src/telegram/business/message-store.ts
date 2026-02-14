import fs from "node:fs";
import path from "node:path";
import type { StoredBusinessMessage, StoredChatMeta } from "./types.js";

const MESSAGES_FILE = "messages.jsonl";
const META_FILE = "meta.json";
const CHATS_DIR = "chats";

function chatDir(baseDir: string, chatId: number): string {
  return path.join(baseDir, CHATS_DIR, String(chatId));
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export function appendBusinessMessage(
  baseDir: string,
  chatId: number,
  msg: StoredBusinessMessage,
): void {
  const dir = chatDir(baseDir, chatId);
  ensureDir(dir);
  const filePath = path.join(dir, MESSAGES_FILE);
  fs.appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf-8");
}

export function appendDeletionMarker(
  baseDir: string,
  chatId: number,
  messageIds: number[],
  businessConnectionId: string,
): void {
  const marker: StoredBusinessMessage = {
    messageId: 0,
    date: Math.floor(Date.now() / 1000),
    storedAt: Date.now(),
    fromId: 0,
    fromFirstName: "",
    direction: "incoming",
    businessConnectionId,
    event: "deleted",
    deletedMessageIds: messageIds,
  };
  appendBusinessMessage(baseDir, chatId, marker);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function readJsonl(filePath: string): StoredBusinessMessage[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const records: StoredBusinessMessage[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as StoredBusinessMessage);
      } catch {
        // Skip corrupt lines.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Deduplicate and filter messages:
 * - For edits, keep only the latest version per messageId.
 * - Remove messages that have been marked as deleted.
 */
function deduplicateMessages(records: StoredBusinessMessage[]): StoredBusinessMessage[] {
  const deletedIds = new Set<number>();
  for (const r of records) {
    if (r.event === "deleted" && r.deletedMessageIds) {
      for (const id of r.deletedMessageIds) {
        deletedIds.add(id);
      }
    }
  }

  // Keep the latest version of each messageId (edits replace originals).
  const byId = new Map<number, StoredBusinessMessage>();
  for (const r of records) {
    if (r.event === "deleted") {
      continue;
    }
    if (deletedIds.has(r.messageId)) {
      continue;
    }
    byId.set(r.messageId, r);
  }

  return [...byId.values()].toSorted((a, b) => a.date - b.date || a.messageId - b.messageId);
}

export function loadChatMessages(
  baseDir: string,
  chatId: number,
  opts?: { limit?: number; before?: number; after?: number },
): StoredBusinessMessage[] {
  const filePath = path.join(chatDir(baseDir, chatId), MESSAGES_FILE);
  const raw = readJsonl(filePath);
  let messages = deduplicateMessages(raw);

  if (opts?.after != null) {
    messages = messages.filter((m) => m.messageId > opts.after!);
  }
  if (opts?.before != null) {
    messages = messages.filter((m) => m.messageId < opts.before!);
  }

  const limit = opts?.limit ?? 50;
  if (limit > 0 && messages.length > limit) {
    // Return the most recent N messages.
    messages = messages.slice(-limit);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Chat listing
// ---------------------------------------------------------------------------

export function updateChatMeta(
  baseDir: string,
  chatId: number,
  partial: Partial<Omit<StoredChatMeta, "messageCount">> & { incrementCount?: boolean },
): void {
  const dir = chatDir(baseDir, chatId);
  ensureDir(dir);
  const filePath = path.join(dir, META_FILE);
  let existing: StoredChatMeta = {
    chatId,
    firstName: "",
    lastMessageAt: 0,
    messageCount: 0,
  };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    existing = JSON.parse(raw) as StoredChatMeta;
  } catch {
    // New chat.
  }
  const { incrementCount, ...rest } = partial;
  const updated: StoredChatMeta = {
    ...existing,
    ...rest,
    chatId,
    messageCount: incrementCount ? existing.messageCount + 1 : existing.messageCount,
  };
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
}

export function listBusinessChats(baseDir: string): StoredChatMeta[] {
  const chatsPath = path.join(baseDir, CHATS_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(chatsPath);
  } catch {
    return [];
  }

  const metas: StoredChatMeta[] = [];
  for (const entry of entries) {
    const metaPath = path.join(chatsPath, entry, META_FILE);
    try {
      const raw = fs.readFileSync(metaPath, "utf-8");
      metas.push(JSON.parse(raw) as StoredChatMeta);
    } catch {
      // Skip directories without valid meta.
    }
  }

  return metas.toSorted((a, b) => b.lastMessageAt - a.lastMessageAt);
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Compact the JSONL file for a chat, enforcing `maxMessages` and `maxAgeDays`
 * limits. Deduplicates edits/deletions, drops expired messages, and caps the
 * retained count. Only rewrites the file when records are actually removed.
 */
export function maybePruneChatMessages(
  baseDir: string,
  chatId: number,
  opts: { maxMessages?: number; maxAgeDays?: number },
): void {
  const maxMessages = opts.maxMessages || 0;
  const maxAgeDays = opts.maxAgeDays || 0;
  if (maxMessages <= 0 && maxAgeDays <= 0) {
    return;
  }

  const filePath = path.join(chatDir(baseDir, chatId), MESSAGES_FILE);
  const raw = readJsonl(filePath);
  if (raw.length === 0) {
    return;
  }

  // Skip if raw count is within the message limit and no age filter applies.
  if (maxMessages > 0 && raw.length <= maxMessages && maxAgeDays <= 0) {
    return;
  }

  let messages = deduplicateMessages(raw);

  if (maxAgeDays > 0) {
    const cutoffSec = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    messages = messages.filter((m) => m.date >= cutoffSec);
  }

  if (maxMessages > 0 && messages.length > maxMessages) {
    messages = messages.slice(-maxMessages);
  }

  // Only rewrite if compaction actually removed records.
  if (messages.length >= raw.length) {
    return;
  }

  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

  // Sync meta message count to match retained messages.
  const metaPath = path.join(chatDir(baseDir, chatId), META_FILE);
  try {
    const metaRaw = fs.readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(metaRaw) as StoredChatMeta;
    meta.messageCount = messages.length;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    // Meta file may not exist yet.
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function searchBusinessMessages(
  baseDir: string,
  query: string,
  opts?: { chatId?: number; limit?: number },
): Array<StoredBusinessMessage & { chatId: number }> {
  const lowerQuery = query.toLowerCase();
  const limit = opts?.limit ?? 20;
  const results: Array<StoredBusinessMessage & { chatId: number }> = [];

  const chatIds: number[] = [];
  if (opts?.chatId != null) {
    chatIds.push(opts.chatId);
  } else {
    const chatsPath = path.join(baseDir, CHATS_DIR);
    try {
      const entries = fs.readdirSync(chatsPath);
      for (const e of entries) {
        const parsed = Number(e);
        if (Number.isFinite(parsed)) {
          chatIds.push(parsed);
        }
      }
    } catch {
      return [];
    }
  }

  for (const cid of chatIds) {
    if (results.length >= limit) {
      break;
    }
    const filePath = path.join(chatDir(baseDir, cid), MESSAGES_FILE);
    const messages = deduplicateMessages(readJsonl(filePath));
    for (const m of messages) {
      if (results.length >= limit) {
        break;
      }
      const text = (m.text ?? m.caption ?? "").toLowerCase();
      if (text.includes(lowerQuery)) {
        results.push({ ...m, chatId: cid });
      }
    }
  }

  return results;
}
