import type { SessionEntry } from "../config/sessions/types.js";
import { updateSessionStore } from "../config/sessions.js";

const TELEGRAM_RECENT_LIMIT = 20;
const TELEGRAM_COMPRESSED_MAX_CHARS = 2500;

export type TelegramQueueTurn = {
  role: "user" | "assistant";
  text: string;
  messageId?: string;
  ts: number;
};

export type TelegramQueueChatMemory = {
  compressedHistory: string;
  recent: TelegramQueueTurn[];
  updatedAt: number;
};

type TelegramQueueMemoryRecord = Record<string, TelegramQueueChatMemory>;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\u0000").join("").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function summarizeCompressedHistory(raw: string): string {
  const text = normalizeText(raw);
  if (!text) {
    return "";
  }
  const lines = text.split("\n").map((line) => line.trim());
  const nonEmpty = lines.filter(Boolean);
  if (nonEmpty.length === 0) {
    return "";
  }
  const tail = nonEmpty.slice(-120).join("\n");
  return truncateText(tail, TELEGRAM_COMPRESSED_MAX_CHARS);
}

function formatTurn(turn: TelegramQueueTurn): string {
  const prefix = turn.role === "assistant" ? "assistant" : "user";
  const idPart = turn.messageId ? ` #${turn.messageId}` : "";
  return `[${prefix}${idPart}] ${turn.text}`;
}

function getMemoryRecord(entry: SessionEntry): TelegramQueueMemoryRecord {
  return (entry.telegramQueueMemory ?? {}) as TelegramQueueMemoryRecord;
}

function getChatMemory(entry: SessionEntry, chatKey: string): TelegramQueueChatMemory {
  const record = getMemoryRecord(entry);
  return (
    record[chatKey] ?? {
      compressedHistory: "",
      recent: [],
      updatedAt: Date.now(),
    }
  );
}

function appendTurn(
  memory: TelegramQueueChatMemory,
  turn: TelegramQueueTurn,
): TelegramQueueChatMemory {
  const recent = [...memory.recent, turn];
  if (recent.length <= TELEGRAM_RECENT_LIMIT) {
    return {
      compressedHistory: memory.compressedHistory,
      recent,
      updatedAt: Date.now(),
    };
  }
  const merged = [memory.compressedHistory, ...recent.map(formatTurn)].filter(Boolean).join("\n");
  return {
    compressedHistory: summarizeCompressedHistory(merged),
    recent: recent.slice(-TELEGRAM_RECENT_LIMIT),
    updatedAt: Date.now(),
  };
}

export function buildTelegramChatMemoryPrompt(memory: TelegramQueueChatMemory): string {
  const compressed = memory.compressedHistory.trim();
  const recent = memory.recent.map(formatTurn).join("\n").trim();
  const parts = [
    compressed ? `[Compressed history]\n${compressed}` : "",
    recent ? `[Recent messages]\n${recent}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

export function buildTelegramChatKey(params: {
  accountId?: string;
  chatId: number | string;
  threadId?: number;
}) {
  const account = (params.accountId ?? "default").trim() || "default";
  const thread = params.threadId != null ? `:thread:${String(params.threadId)}` : "";
  return `${account}:chat:${String(params.chatId)}${thread}`;
}

export async function appendTelegramQueueTurn(params: {
  storePath: string;
  sessionKey: string;
  chatKey: string;
  turn: TelegramQueueTurn;
}): Promise<TelegramQueueChatMemory | null> {
  const { storePath, sessionKey, chatKey } = params;
  const text = normalizeText(params.turn.text);
  if (!text) {
    return null;
  }
  const nextTurn: TelegramQueueTurn = {
    role: params.turn.role,
    text,
    messageId: params.turn.messageId,
    ts: params.turn.ts,
  };
  return await updateSessionStore(storePath, (store) => {
    const existing = store[sessionKey];
    if (!existing) {
      return null;
    }
    const record = getMemoryRecord(existing);
    const current = getChatMemory(existing, chatKey);
    const nextMemory = appendTurn(current, nextTurn);
    const nextRecord: TelegramQueueMemoryRecord = {
      ...record,
      [chatKey]: nextMemory,
    };
    store[sessionKey] = {
      ...existing,
      telegramQueueMemory: nextRecord,
      updatedAt: Date.now(),
    };
    return nextMemory;
  });
}

export async function loadTelegramQueueMemory(params: {
  storePath: string;
  sessionKey: string;
  chatKey: string;
}): Promise<TelegramQueueChatMemory | null> {
  return await updateSessionStore(params.storePath, (store) => {
    const entry = store[params.sessionKey];
    if (!entry) {
      return null;
    }
    return getChatMemory(entry, params.chatKey);
  });
}
