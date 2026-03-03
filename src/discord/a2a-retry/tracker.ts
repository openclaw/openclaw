import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { resolveStateDir } from "../../config/paths.js";

export type TrackedMentionStatus = "pending" | "responded" | "failed";

export interface TrackedMention {
  id: string;
  messageId: string;
  threadId: string;
  fromAgentId: string;
  targetAgentId: string;
  targetBotId: string;
  originalText: string;
  status: TrackedMentionStatus;
  sentAt: number;
  attempts: number;
  lastAttemptAt: number;
  respondedAt?: number;
}

export interface A2aMentionStore {
  version: number;
  tracked: Record<string, TrackedMention>;
}

const STORE_VERSION = 1;
const STORE_FILENAME = "a2a-mention-tracking.json";
const MAX_TRACKED = 1000;

// ── In-memory cache ─────────────────────────────────────────────────
let cachedStore: A2aMentionStore | null = null;

function getStorePath(): string {
  return path.join(resolveStateDir(), STORE_FILENAME);
}

function createEmptyStore(): A2aMentionStore {
  return { version: STORE_VERSION, tracked: {} };
}

function isValidStore(value: unknown): value is A2aMentionStore {
  return (
    !!value &&
    typeof value === "object" &&
    "version" in value &&
    "tracked" in value &&
    typeof (value as A2aMentionStore).tracked === "object"
  );
}

export function loadA2aMentionStore(): A2aMentionStore {
  if (cachedStore) {
    return cachedStore;
  }
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (isValidStore(parsed)) {
      cachedStore = parsed;
      return parsed;
    }
    const empty = createEmptyStore();
    cachedStore = empty;
    return empty;
  } catch {
    const empty = createEmptyStore();
    cachedStore = empty;
    return empty;
  }
}

/** Invalidate the in-memory cache (for tests). */
export function invalidateA2aMentionCache(): void {
  cachedStore = null;
}

async function saveA2aMentionStore(store: A2aMentionStore): Promise<void> {
  cachedStore = store;
  const storePath = getStorePath();
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function trackOutboundMention(params: {
  messageId: string;
  threadId: string;
  fromAgentId: string;
  targetAgentId: string;
  targetBotId: string;
  originalText: string;
}): Promise<TrackedMention> {
  const store = loadA2aMentionStore();
  const now = Date.now();
  const mention: TrackedMention = {
    id: crypto.randomUUID(),
    messageId: params.messageId,
    threadId: params.threadId,
    fromAgentId: params.fromAgentId,
    targetAgentId: params.targetAgentId,
    targetBotId: params.targetBotId,
    originalText: params.originalText,
    sentAt: now,
    attempts: 1,
    lastAttemptAt: now,
    status: "pending",
  };
  store.tracked[mention.id] = mention;

  // Evict oldest non-pending entries when exceeding capacity
  const ids = Object.keys(store.tracked);
  if (ids.length > MAX_TRACKED) {
    const nonPending = Object.values(store.tracked)
      .filter((m) => m.status !== "pending")
      .toSorted((a, b) => a.lastAttemptAt - b.lastAttemptAt);
    const excess = ids.length - MAX_TRACKED;
    for (let i = 0; i < excess && i < nonPending.length; i++) {
      delete store.tracked[nonPending[i].id];
    }
  }

  await saveA2aMentionStore(store);
  return mention;
}

/**
 * Mark the OLDEST pending mention as responded (FIFO).
 *
 * When `beforeTimestamp` is provided, only mentions with `sentAt <= beforeTimestamp`
 * are eligible — this prevents a single response from clearing future mentions
 * that haven't been seen yet (e.g. when A sends two collaborate() calls to B
 * in the same thread, B's first response should only clear the first mention).
 */
export async function markMentionResponded(
  threadId: string,
  responderAgentId: string,
  options?: { beforeTimestamp?: number },
): Promise<number> {
  const store = loadA2aMentionStore();
  const now = Date.now();

  // Find the oldest pending mention that matches (FIFO)
  let oldestMatch: TrackedMention | null = null;
  for (const mention of Object.values(store.tracked)) {
    if (mention.threadId !== threadId) {
      continue;
    }
    if (mention.status !== "pending") {
      continue;
    }
    if (mention.targetAgentId !== responderAgentId) {
      continue;
    }
    if (options?.beforeTimestamp !== undefined && mention.sentAt > options.beforeTimestamp) {
      continue;
    }
    if (!oldestMatch || mention.sentAt < oldestMatch.sentAt) {
      oldestMatch = mention;
    }
  }

  if (oldestMatch) {
    oldestMatch.status = "responded";
    oldestMatch.respondedAt = now;
    await saveA2aMentionStore(store);
    return 1;
  }
  return 0;
}

export function getTimedOutMentions(timeoutMs: number): TrackedMention[] {
  const store = loadA2aMentionStore();
  const now = Date.now();
  return Object.values(store.tracked).filter(
    (mention) => mention.status === "pending" && now - mention.lastAttemptAt >= timeoutMs,
  );
}

export async function incrementMentionAttempt(id: string): Promise<TrackedMention | null> {
  const store = loadA2aMentionStore();
  const mention = store.tracked[id];
  if (!mention) {
    return null;
  }
  mention.attempts += 1;
  mention.lastAttemptAt = Date.now();
  await saveA2aMentionStore(store);
  return mention;
}

export async function markMentionFailed(id: string): Promise<TrackedMention | null> {
  const store = loadA2aMentionStore();
  const mention = store.tracked[id];
  if (!mention) {
    return null;
  }
  mention.status = "failed";
  await saveA2aMentionStore(store);
  return mention;
}

export async function cleanupOldEntries(maxAgeMs: number): Promise<number> {
  const store = loadA2aMentionStore();
  const now = Date.now();
  let count = 0;
  for (const [id, mention] of Object.entries(store.tracked)) {
    if (mention.status !== "pending" && now - mention.lastAttemptAt > maxAgeMs) {
      delete store.tracked[id];
      count++;
    }
  }
  if (count > 0) {
    await saveA2aMentionStore(store);
  }
  return count;
}
