/**
 * In-memory store for Slack Assistant thread context.
 *
 * Tracks which channel/team a user was viewing when they opened an assistant
 * thread, so downstream handlers can provide channel-aware responses.
 *
 * Entries expire after 24 hours to prevent unbounded memory growth.
 */

import { logVerbose } from "../../globals.js";

export type AssistantThreadContext = {
  /** The channel the user was viewing when the assistant thread was opened/updated. */
  channelId?: string;
  /** The team (workspace) id. */
  teamId?: string;
  /** The enterprise grid id (if applicable). */
  enterpriseId?: string;
};

type StoredEntry = {
  context: AssistantThreadContext;
  storedAt: number;
};

/** 24 hours in milliseconds. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Cleanup runs at most every 10 minutes. */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const store = new Map<string, StoredEntry>();
let lastCleanup = Date.now();

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanup = now;
  const cutoff = now - TTL_MS;
  let removed = 0;
  for (const [key, entry] of store) {
    if (entry.storedAt < cutoff) {
      store.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logVerbose(`slack assistant context: cleaned up ${removed} expired entries`);
  }
}

/**
 * Save or update the assistant thread context.
 */
export function saveThreadContext(
  channelId: string,
  threadTs: string,
  context: AssistantThreadContext,
): void {
  cleanupExpired();
  const key = makeKey(channelId, threadTs);
  store.set(key, { context, storedAt: Date.now() });
  logVerbose(
    `slack assistant context: saved context for ${key} (viewingChannel=${context.channelId ?? "none"})`,
  );
}

/**
 * Retrieve the assistant thread context, or undefined if not found or expired.
 */
export function getThreadContext(
  channelId: string,
  threadTs: string,
): AssistantThreadContext | undefined {
  const key = makeKey(channelId, threadTs);
  const entry = store.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.storedAt > TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return entry.context;
}

/**
 * Check if a thread has assistant context stored (i.e., it was started via the assistant panel).
 */
export function isAssistantThread(channelId: string, threadTs: string): boolean {
  return getThreadContext(channelId, threadTs) !== undefined;
}

/** Visible for testing: clear all stored contexts. */
export function _clearAllContexts(): void {
  store.clear();
}
