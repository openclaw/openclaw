import { resolveGlobalMap } from "../shared/global-singleton.js";

/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 *
 * The cache is persisted to disk so that thread participation survives gateway
 * restarts.  Writes are debounced (at most once per PERSIST_DEBOUNCE_MS) and
 * reads happen once on first access.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;
const PERSIST_DEBOUNCE_MS = 5_000;
const PERSIST_FILENAME = "slack-thread-participation.json";

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");

const threadParticipation = resolveGlobalMap<string, number>(SLACK_THREAD_PARTICIPATION_KEY);

let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPathOverride: string | undefined;

function persistPath(): string {
  if (persistPathOverride) {
    return persistPathOverride;
  }
  return path.join(resolveStateDir(), PERSIST_FILENAME);
}

// -- Persistence: load --

function loadFromDisk(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const raw = fs.readFileSync(persistPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const entries = parsed as Record<string, unknown>;
    const now = Date.now();
    for (const [key, ts] of Object.entries(entries)) {
      if (typeof ts === "number" && now - ts <= TTL_MS) {
        threadParticipation.set(key, ts);
      }
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
}

// -- Persistence: save (debounced) --

function schedulePersist(): void {
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistToDisk();
  }, PERSIST_DEBOUNCE_MS);
  // Don't hold the process open for a debounced persist.
  if (typeof persistTimer === "object" && "unref" in persistTimer) {
    persistTimer.unref();
  }
}

function persistToDisk(): void {
  try {
    const obj: Record<string, number> = {};
    for (const [key, ts] of threadParticipation) {
      obj[key] = ts;
    }
    const filePath = persistPath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
  } catch {
    // Best-effort — don't crash on write failure.
  }
}

// -- Public API --

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of threadParticipation) {
    if (now - timestamp > TTL_MS) {
      threadParticipation.delete(key);
    }
  }
}

function evictOldest(): void {
  const oldest = threadParticipation.keys().next().value;
  if (oldest) {
    threadParticipation.delete(oldest);
  }
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  loadFromDisk();
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictExpired();
  }
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictOldest();
  }
  threadParticipation.set(makeKey(accountId, channelId, threadTs), Date.now());
  schedulePersist();
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  loadFromDisk();
  const key = makeKey(accountId, channelId, threadTs);
  const timestamp = threadParticipation.get(key);
  if (timestamp == null) {
    return false;
  }
  if (Date.now() - timestamp > TTL_MS) {
    threadParticipation.delete(key);
    schedulePersist();
    return false;
  }
  return true;
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  // Persist the empty state so the clear survives restarts.
  // We persist even if the cache hasn't been loaded yet — an existing
  // persist file with stale entries should be wiped.
  persistToDisk();
  loaded = true;
}

/** @internal — test helper to override persist path and reset load state. */
export function _resetForTests(overridePath?: string): void {
  threadParticipation.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  loaded = false;
  persistPathOverride = overridePath;
}

/** @internal — flush any pending persist immediately (for tests). */
export function _flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistToDisk();
}
