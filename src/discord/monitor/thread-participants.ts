/**
 * Thread Participant Tracking — tracks which bots participate in which threads.
 * Participants can converse in threads without explicit @mentions.
 *
 * Persistence: in-memory Map + async disk flush to ~/.openclaw/state/thread-participants.json
 * TTL: 24h from last activity per thread
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { resolveStateDir } from "../../config/paths.js";

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

function resolveThreadParticipantStatePath(dir: string): string {
  return resolve(dir, "thread-participants.json");
}

/**
 * Thread participants must live under the shared OpenClaw state root, not process.cwd().
 *
 * Gateway startup, agent workspaces, and repo-local dev shells can all have different cwd values.
 * If participant persistence follows cwd, one process writes thread membership into its own local
 * state file while another process restores from a different empty file after restart. That split
 * state is exactly what makes thread messages reach Discord but never reach an agent session.
 */
function resolveCanonicalThreadParticipantStateDir(): string {
  return resolve(resolveStateDir(process.env, os.homedir), "state");
}

function getStatePath(): string | null {
  const dir = stateDir ?? resolveCanonicalThreadParticipantStateDir();
  try {
    mkdirSync(dir, { recursive: true });
    stateDir = dir;
    return resolveThreadParticipantStatePath(dir);
  } catch {
    return null;
  }
}

function readStore(path: string): ThreadParticipantStore | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const store: ThreadParticipantStore = JSON.parse(raw);
    if (store.version !== 1 || !store.threads) {
      return null;
    }
    return store;
  } catch {
    return null;
  }
}

function mergeStoreIntoMap(
  map: Map<string, ThreadParticipantEntry>,
  store: ThreadParticipantStore,
  now: number,
): number {
  let merged = 0;
  for (const entry of Object.values(store.threads)) {
    if (now - entry.lastActivityAt > PARTICIPANT_TTL_MS) {
      continue;
    }
    const existing = map.get(entry.threadId);
    const participants = [...new Set(entry.participants)];
    if (!existing) {
      map.set(entry.threadId, {
        ...entry,
        participants,
      });
      merged++;
      continue;
    }
    const mergedParticipants = [...new Set([...existing.participants, ...participants])];
    const mergedEntry: ThreadParticipantEntry = {
      threadId: entry.threadId,
      participants: mergedParticipants,
      createdAt: Math.min(existing.createdAt, entry.createdAt),
      lastActivityAt: Math.max(existing.lastActivityAt, entry.lastActivityAt),
    };
    const didChange =
      mergedEntry.createdAt !== existing.createdAt ||
      mergedEntry.lastActivityAt !== existing.lastActivityAt ||
      mergedEntry.participants.length !== existing.participants.length;
    if (didChange) {
      map.set(entry.threadId, mergedEntry);
      merged++;
    }
  }
  return merged;
}

/**
 * Legacy collaboration builds could persist thread participants relative to a repo or per-agent
 * workspace cwd. Keep reading those files during startup so the first restart after this fix does
 * not drop still-live collaboration threads. Any imported entries are immediately re-written into
 * the canonical shared state file so future restarts no longer depend on legacy paths.
 */
function resolveLegacyThreadParticipantStatePaths(canonicalPath: string): string[] {
  const paths = new Set<string>();

  try {
    const cwdPath = resolve(process.cwd(), "state", "thread-participants.json");
    if (cwdPath !== canonicalPath) {
      paths.add(cwdPath);
    }
  } catch {
    // Ignore cwd resolution failures and rely on the canonical state file.
  }

  const sharedStateRoot = resolveStateDir(process.env, os.homedir);
  try {
    for (const entry of readdirSync(sharedStateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("workspace-")) {
        continue;
      }
      const workspacePath = resolve(
        sharedStateRoot,
        entry.name,
        "state",
        "thread-participants.json",
      );
      if (workspacePath !== canonicalPath) {
        paths.add(workspacePath);
      }
    }
  } catch {
    // Missing workspace directories are fine; canonical state remains the source of truth.
  }

  return [...paths];
}

// ── Persistence ────────────────────────────────────────────────────

export function loadThreadParticipants(): void {
  const path = getStatePath();
  if (!path) {
    return;
  }
  const map = getParticipantMap();
  const now = Date.now();

  const canonicalStore = readStore(path);
  if (canonicalStore) {
    mergeStoreIntoMap(map, canonicalStore, now);
  }

  let importedLegacyEntries = 0;
  for (const legacyPath of resolveLegacyThreadParticipantStatePaths(path)) {
    const legacyStore = readStore(legacyPath);
    if (!legacyStore) {
      continue;
    }
    importedLegacyEntries += mergeStoreIntoMap(map, legacyStore, now);
  }

  if (importedLegacyEntries > 0) {
    flushToDisk();
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
 * Set custom state directory (for testing or explicit configuration).
 */
export function setThreadParticipantStateDir(dir: string): void {
  stateDir = resolve(dir);
}

/**
 * Clear all participants (for tests).
 */
export function clearThreadParticipants(): void {
  const map = getParticipantMap();
  map.clear();
  scheduleFlush();
}
