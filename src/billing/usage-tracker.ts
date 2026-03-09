/**
 * Per-user usage tracking for the SaaS paywall.
 *
 * Tracks message counts and token estimates per user, persisted to
 * ~/.openclaw/billing/usage.json. "User" is identified by the gateway
 * connect token's first-16-chars prefix (or "anonymous" for unauthenticated).
 */

import path from "node:path";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolveStateDir } from "../config/paths.js";

export type UserUsageRecord = {
  /** Truncated token prefix used as an opaque identifier (never the full token). */
  userId: string;
  /** Human-readable label if available (e.g. device name passed at connect). */
  label?: string;
  /** Total messages sent (chat.send calls). */
  messagesSent: number;
  /** Rough token estimate (message char length / 4, cumulative). */
  estimatedTokens: number;
  /** ISO timestamp of first activity. */
  firstSeen: string;
  /** ISO timestamp of most recent activity. */
  lastSeen: string;
};

type UsageStore = {
  version: 1;
  users: Record<string, UserUsageRecord>;
};

function resolveStorePath(): string {
  return path.join(resolveStateDir(), "billing", "usage.json");
}

function loadStore(): UsageStore {
  const raw = loadJsonFile(resolveStorePath());
  if (
    raw &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).version === 1 &&
    typeof (raw as Record<string, unknown>).users === "object"
  ) {
    return raw as UsageStore;
  }
  return { version: 1, users: {} };
}

function saveStore(store: UsageStore): void {
  saveJsonFile(resolveStorePath(), store);
}

/**
 * Derive an opaque user ID from a connect token or fallback.
 * Uses a 16-char prefix so the full token is never stored.
 */
export function resolveUserId(token: string | undefined | null): string {
  if (!token || token.trim() === "") {
    return "anonymous";
  }
  // Store only the first 16 chars — enough to identify a session, not enough to reuse the token
  return token.trim().slice(0, 16);
}

/** Record one chat message from a user. */
export function recordMessage(params: {
  userId: string;
  label?: string;
  messageLength?: number;
}): void {
  const store = loadStore();
  const now = new Date().toISOString();
  const existing = store.users[params.userId];
  const tokenDelta = Math.ceil((params.messageLength ?? 0) / 4);

  if (existing) {
    existing.messagesSent += 1;
    existing.estimatedTokens += tokenDelta;
    existing.lastSeen = now;
    if (params.label && !existing.label) {
      existing.label = params.label;
    }
  } else {
    store.users[params.userId] = {
      userId: params.userId,
      label: params.label,
      messagesSent: 1,
      estimatedTokens: tokenDelta,
      firstSeen: now,
      lastSeen: now,
    };
  }

  saveStore(store);
}

/** Returns all user records sorted by lastSeen descending. */
export function getAllUserUsage(): UserUsageRecord[] {
  const store = loadStore();
  return Object.values(store.users).sort(
    (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
  );
}

/** Returns a single user's record, or undefined. */
export function getUserUsage(userId: string): UserUsageRecord | undefined {
  return loadStore().users[userId];
}

/** Summary stats across all users. */
export function getUsageSummary(): {
  totalUsers: number;
  totalMessages: number;
  totalEstimatedTokens: number;
} {
  const store = loadStore();
  const users = Object.values(store.users);
  return {
    totalUsers: users.length,
    totalMessages: users.reduce((s, u) => s + u.messagesSent, 0),
    totalEstimatedTokens: users.reduce((s, u) => s + u.estimatedTokens, 0),
  };
}
