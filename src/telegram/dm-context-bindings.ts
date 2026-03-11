import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "../globals.js";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { normalizeAccountId } from "../routing/session-key.js";

const STORE_VERSION = 1;
const STORE_DIR = "telegram";
const STORE_FILENAME = "dm-context-bindings.v1.json";

export type TelegramDmContextBinding = {
  accountId: string;
  dmChatId: string;
  chatId: string;
  topicId: number;
  conversationId: string; // <chat_id>:topic:<topic_id>
  updatedAtMs: number;
};

type StoreShape = {
  version: number;
  bindings: Record<string, TelegramDmContextBinding>;
};

function resolveStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_DIR, STORE_FILENAME);
}

function resolveBindingKey(accountId: string, dmChatId: string): string {
  return `${normalizeAccountId(accountId)}:${dmChatId}`;
}

function loadStore(stateDir: string): StoreShape {
  const storePath = resolveStorePath(stateDir);
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    if (parsed?.version !== STORE_VERSION || !parsed.bindings) {
      logVerbose(
        `telegram dm context bindings: store version mismatch or invalid shape at ${storePath} (resetting)`,
      );
      return { version: STORE_VERSION, bindings: {} };
    }
    return { version: STORE_VERSION, bindings: parsed.bindings };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      logVerbose(
        `telegram dm context bindings: failed to load ${storePath} (${String(err)}) (resetting)`,
      );
    }
    return { version: STORE_VERSION, bindings: {} };
  }
}

async function saveStore(stateDir: string, store: StoreShape) {
  const storePath = resolveStorePath(stateDir);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  await writeJsonAtomic(storePath, store);
}

let storeWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueStoreWrite<T>(op: () => Promise<T>): Promise<T> {
  const next = storeWriteQueue.then(op, op);
  // Ensure queue continues even if op rejects.
  storeWriteQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function buildTelegramForumConversationId(chatId: string, topicId: number): string {
  return `${chatId}:topic:${topicId}`;
}

export function parseTelegramChatId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function parseTelegramTopicId(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function validateTargetChatId(chatId: string): string | undefined {
  // Telegram group/supergroup IDs are negative. (We intentionally disallow channels/usernames here.)
  return /^-\d+$/.test(chatId) ? chatId : undefined;
}

export function getTelegramDmContextBinding(params: {
  accountId: string;
  dmChatId: string;
}): TelegramDmContextBinding | undefined {
  const stateDir = resolveStateDir();
  const store = loadStore(stateDir);
  return store.bindings[resolveBindingKey(params.accountId, params.dmChatId)];
}

export async function setTelegramDmContextBinding(params: {
  accountId: string;
  dmChatId: string;
  chatId: string;
  topicId: number;
}): Promise<TelegramDmContextBinding> {
  return enqueueStoreWrite(async () => {
    const stateDir = resolveStateDir();
    const store = loadStore(stateDir);
    const now = Date.now();
    const binding: TelegramDmContextBinding = {
      accountId: normalizeAccountId(params.accountId),
      dmChatId: params.dmChatId,
      chatId: params.chatId,
      topicId: params.topicId,
      conversationId: buildTelegramForumConversationId(params.chatId, params.topicId),
      updatedAtMs: now,
    };
    store.bindings[resolveBindingKey(params.accountId, params.dmChatId)] = binding;
    await saveStore(stateDir, store);
    return binding;
  });
}

export async function clearTelegramDmContextBinding(params: {
  accountId: string;
  dmChatId: string;
}): Promise<boolean> {
  return enqueueStoreWrite(async () => {
    const stateDir = resolveStateDir();
    const store = loadStore(stateDir);
    const key = resolveBindingKey(params.accountId, params.dmChatId);
    const existed = Boolean(store.bindings[key]);
    if (existed) {
      delete store.bindings[key];
      await saveStore(stateDir, store);
    }
    return existed;
  });
}

export const __testing = {
  resolveStorePath,
  loadStore,
};
