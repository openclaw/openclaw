/**
 * Thread Participant Tracking — tracks which bots participate in which threads.
 * Participants can converse in threads without explicit @mentions.
 *
 * Persistence: in-memory Map + async disk flush to state/thread-participants.json
 * TTL: 24h from last activity per thread
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface ThreadParticipantEntry {
  threadId: string;
  participants: string[]; // botUserId list
  createdAt: number;
  lastActivityAt: number;
}

interface ThreadParticipantStore {
  version: number;
  threads: Record<string, ThreadParticipantEntry>;
}

// ── Constants ──────────────────────────────────────────────────────

const GLOBAL_KEY = "__openclaw_threadParticipants__";
const PARTICIPANT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DEBOUNCE_MS = 1_000;

// ── Internal State ─────────────────────────────────────────────────

function getParticipantMap(): Map<string, ThreadParticipantEntry> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ThreadParticipantEntry>();
  }
  return g[GLOBAL_KEY] as Map<string, ThreadParticipantEntry>;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let stateDir: string | null = null;

// ── State Directory ────────────────────────────────────────────────

function getStatePath(): string | null {
  if (stateDir) {
    return resolve(stateDir, "thread-participants.json");
  }
  // Try common state dir locations
  const candidates = [process.env.OPENCLAW_STATE_DIR, resolve(process.cwd(), "state")].filter(
    Boolean,
  ) as string[];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      stateDir = dir;
      return resolve(dir, "thread-participants.json");
    } catch {
      continue;
    }
  }
  return null;
}

// ── Persistence ────────────────────────────────────────────────────

export function loadThreadParticipants(): void {
  const path = getStatePath();
  if (!path) {
    return;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const store: ThreadParticipantStore = JSON.parse(raw);
    if (store.version !== 1 || !store.threads) {
      return;
    }
    const map = getParticipantMap();
    const now = Date.now();
    for (const [threadId, entry] of Object.entries(store.threads)) {
      // Skip expired entries
      if (now - entry.lastActivityAt > PARTICIPANT_TTL_MS) {
        continue;
      }
      map.set(threadId, {
        ...entry,
        participants: [...entry.participants],
      });
    }
  } catch {
    // Safe degradation: start empty, mention-only mode
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDisk();
  }, FLUSH_DEBOUNCE_MS);
}

function flushToDisk(): void {
  const path = getStatePath();
  if (!path) {
    return;
  }
  try {
    const map = getParticipantMap();
    const store: ThreadParticipantStore = {
      version: 1,
      threads: Object.fromEntries(map.entries()),
    };
    writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // Log warning but don't crash — persistence is best-effort
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Register a bot as a participant in a thread.
 * Called when: collaborate() creates/uses thread, bot is mentioned in thread, bot sends message in thread.
 */
export function registerThreadParticipant(threadId: string, botUserId: string): void {
  const map = getParticipantMap();
  const now = Date.now();
  let entry = map.get(threadId);
  if (!entry) {
    entry = {
      threadId,
      participants: [],
      createdAt: now,
      lastActivityAt: now,
    };
    map.set(threadId, entry);
  }
  if (!entry.participants.includes(botUserId)) {
    entry.participants.push(botUserId);
  }
  entry.lastActivityAt = now;
  scheduleFlush();
}

/**
 * Register multiple bots at once (e.g., collaborate() registers both sender and target).
 */
export function registerThreadParticipants(threadId: string, botUserIds: string[]): void {
  for (const id of botUserIds) {
    registerThreadParticipant(threadId, id);
  }
}

/**
 * Check if a bot is a participant in a thread.
 */
export function isThreadParticipant(threadId: string, botUserId: string): boolean {
  const map = getParticipantMap();
  const entry = map.get(threadId);
  if (!entry) {
    return false;
  }
  // Check TTL
  if (Date.now() - entry.lastActivityAt > PARTICIPANT_TTL_MS) {
    map.delete(threadId);
    scheduleFlush();
    return false;
  }
  return entry.participants.includes(botUserId);
}

/**
 * Update last activity timestamp for a thread (call when any message is sent/received).
 */
export function touchThreadActivity(threadId: string): void {
  const map = getParticipantMap();
  const entry = map.get(threadId);
  if (entry) {
    entry.lastActivityAt = Date.now();
    scheduleFlush();
  }
}

/**
 * Check if a thread has any registered participants (i.e., is a collaboration thread).
 */
export function hasThreadParticipants(threadId: string): boolean {
  const map = getParticipantMap();
  const entry = map.get(threadId);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.lastActivityAt > PARTICIPANT_TTL_MS) {
    map.delete(threadId);
    scheduleFlush();
    return false;
  }
  return entry.participants.length > 0;
}

/**
 * Get all participants for a thread.
 */
export function getThreadParticipants(threadId: string): string[] {
  const map = getParticipantMap();
  const entry = map.get(threadId);
  if (!entry) {
    return [];
  }
  if (Date.now() - entry.lastActivityAt > PARTICIPANT_TTL_MS) {
    map.delete(threadId);
    scheduleFlush();
    return [];
  }
  return [...entry.participants];
}

/**
 * Remove expired entries (garbage collection). Call periodically.
 */
export function cleanupExpiredThreads(): number {
  const map = getParticipantMap();
  const now = Date.now();
  let removed = 0;
  for (const [threadId, entry] of map.entries()) {
    if (now - entry.lastActivityAt > PARTICIPANT_TTL_MS) {
      map.delete(threadId);
      removed++;
    }
  }
  if (removed > 0) {
    scheduleFlush();
  }
  return removed;
}

/**
 * Flush participant data to disk synchronously.
 * Intended for use in process exit handlers where async I/O is not possible.
 */
export function flushToDiskSync(): void {
  flushToDisk();
}

/**
 * Register a process exit handler that flushes participant data to disk.
 * Call once during gateway startup to prevent data loss on shutdown.
 */
export function registerThreadParticipantExitHandler(): void {
  process.on("exit", flushToDiskSync);
}

/**
 * Start periodic garbage collection for expired thread entries.
 * Returns a cleanup function that stops the interval timer.
 */
export function startThreadParticipantMaintenance(): { stop: () => void } {
  const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const timer = setInterval(() => {
    cleanupExpiredThreads();
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

/**
 * Set custom state directory (for testing or explicit configuration).
 */
export function setThreadParticipantStateDir(dir: string): void {
  stateDir = dir;
}

/**
 * Clear all participants (for tests).
 */
export function clearThreadParticipants(): void {
  const map = getParticipantMap();
  map.clear();
  scheduleFlush();
}
