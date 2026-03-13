import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { CONFIG_DIR } from "../../utils.js";

// ── Types ──

export type BotHistoryEntry = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  text: string;
  timestamp: number;
  source?: string;
};

type BotHistoryStore = {
  version: 1;
  entries: BotHistoryEntry[];
};

// ── Constants ──

const DEFAULT_BOT_HISTORY_DIR = path.join(CONFIG_DIR, "bot-history");
const DEFAULT_STORE_PATH = path.join(DEFAULT_BOT_HISTORY_DIR, "pending.json");
const MAX_ENTRIES = 500;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COMPACTION_THRESHOLD = 400;

// ── In-memory cache (same pattern as cron store's serializedStoreCache) ──

const serializedStoreCache = new Map<string, string>();

// ── Internal helpers ──

function resolveStorePath(override?: string): string {
  return override ?? DEFAULT_STORE_PATH;
}

async function loadStore(storePath: string): Promise<BotHistoryStore> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const entries = Array.isArray(record.entries) ? (record.entries as BotHistoryEntry[]) : [];
      const store: BotHistoryStore = { version: 1, entries };
      serializedStoreCache.set(storePath, JSON.stringify(store));
      return store;
    }
    return { version: 1, entries: [] };
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      return { version: 1, entries: [] };
    }
    throw err;
  }
}

async function saveStore(storePath: string, store: BotHistoryStore): Promise<void> {
  const storeDir = path.dirname(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);
  const json = JSON.stringify(store);
  const cached = serializedStoreCache.get(storePath);
  if (cached === json) {
    return;
  }
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600).catch(() => undefined);
  await renameWithRetry(tmp, storePath);
  await fs.promises.chmod(storePath, 0o600).catch(() => undefined);
  serializedStoreCache.set(storePath, json);
}

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

// ── Exported functions ──

type StoreOptions = { storePath?: string };

/**
 * Normalize `to` to match the OriginatingTo format used by each channel's
 * inbound handler. This ensures recording and flushing use the same key.
 *
 * Telegram: OriginatingTo is always "telegram:{chatId}", but cron delivery.to
 *   may be a bare chatId when set explicitly by the job config.
 * Other channels: delivery.to already matches OriginatingTo format.
 */
export function normalizeToForBotHistory(channel: string, to: string): string {
  if (channel === "telegram" && !to.startsWith("telegram:")) {
    return `telegram:${to}`;
  }
  return to;
}

export async function readBotHistoryEntries(
  query: { channel: string; to: string; accountId?: string; threadId?: string },
  opts?: StoreOptions,
): Promise<BotHistoryEntry[]> {
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);
  return store.entries.filter(
    (e) =>
      e.channel === query.channel &&
      e.to === query.to &&
      e.accountId === query.accountId &&
      e.threadId === query.threadId,
  );
}

export async function appendBotHistoryEntry(
  entry: Omit<BotHistoryEntry, "id">,
  opts?: StoreOptions,
): Promise<void> {
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);

  // Lazy compaction when threshold exceeded
  if (store.entries.length >= COMPACTION_THRESHOLD) {
    compactEntries(store);
  }

  // Enforce max entries — drop oldest if at capacity
  if (store.entries.length >= MAX_ENTRIES) {
    store.entries.sort((a, b) => a.timestamp - b.timestamp);
    store.entries.splice(0, store.entries.length - MAX_ENTRIES + 1);
  }

  store.entries.push({ ...entry, id: randomUUID() });
  await saveStore(storePath, store);
}

export async function removeBotHistoryEntries(ids: string[], opts?: StoreOptions): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);
  const idSet = new Set(ids);
  store.entries = store.entries.filter((e) => !idSet.has(e.id));
  await saveStore(storePath, store);
}

export async function compactBotHistoryStore(opts?: StoreOptions): Promise<number> {
  const storePath = resolveStorePath(opts?.storePath);
  const store = await loadStore(storePath);
  const before = store.entries.length;
  compactEntries(store);
  if (store.entries.length !== before) {
    await saveStore(storePath, store);
  }
  return before - store.entries.length;
}

function compactEntries(store: BotHistoryStore): void {
  const cutoff = Date.now() - TTL_MS;
  store.entries = store.entries.filter((e) => e.timestamp > cutoff);
}

export async function flushBotHistoryToTranscript(params: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  sessionKey: string;
  agentId: string;
  storePath?: string;
}): Promise<number> {
  const entries = await readBotHistoryEntries(
    {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
    },
    { storePath: params.storePath },
  );
  if (entries.length === 0) {
    return 0;
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Flush each entry individually. Only remove entries that succeed —
  // failed entries stay for the next flush attempt.
  const flushedIds: string[] = [];
  for (const entry of entries) {
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      text: `[Sent via scheduled task (${entry.source ?? "cron"})]\n${entry.text}`,
    });
    if (result.ok) {
      flushedIds.push(entry.id);
    }
  }

  if (flushedIds.length > 0) {
    await removeBotHistoryEntries(flushedIds, { storePath: params.storePath });
  }
  return flushedIds.length;
}

// For tests: reset the in-memory cache
export function _resetBotHistoryCache(): void {
  serializedStoreCache.clear();
}
