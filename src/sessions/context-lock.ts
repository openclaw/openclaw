import type { ContextLock, SessionEntry } from "../config/sessions/types.js";
import { logWarn } from "../logger.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type ContextLockCreateParams = {
  shopKey: string;
  browserProfile: string;
  activeTabId?: string;
  dateFilter?: string;
  pageUrl?: string;
};

/**
 * Create a new context lock on a session entry.
 */
export function createContextLock(entry: SessionEntry, params: ContextLockCreateParams): void {
  entry.contextLock = {
    shopKey: params.shopKey,
    browserProfile: params.browserProfile,
    activeTabId: params.activeTabId,
    dateFilter: params.dateFilter,
    pageUrl: params.pageUrl,
    lockedAt: Date.now(),
    ttlMs: DEFAULT_TTL_MS,
    lockVersion: 1,
  };
  entry.updatedAt = Date.now();
}

/**
 * Clear the context lock from a session entry.
 */
export function clearContextLock(entry: SessionEntry): void {
  if (entry.contextLock) {
    delete entry.contextLock;
    entry.updatedAt = Date.now();
  }
}

export type ContextLockCheckResult =
  | { status: "active"; lock: ContextLock }
  | { status: "expired" }
  | { status: "none" };

/**
 * Check the context lock state. If expired, clears it and logs a warning.
 */
export function checkContextLock(entry: SessionEntry): ContextLockCheckResult {
  if (!entry.contextLock) {
    return { status: "none" };
  }

  const lock = entry.contextLock;
  const now = Date.now();

  if (lock.lockedAt + lock.ttlMs < now) {
    logWarn(
      `[context-lock] Lock expired for shop "${lock.shopKey}" ` +
        `(locked ${Math.round((now - lock.lockedAt) / 60_000)}min ago, ttl=${Math.round(lock.ttlMs / 60_000)}min)`,
    );
    clearContextLock(entry);
    return { status: "expired" };
  }

  return { status: "active", lock };
}

/**
 * Bump lockVersion after a successful model switch restore.
 */
export function bumpContextLockVersion(entry: SessionEntry): void {
  if (entry.contextLock) {
    entry.contextLock.lockVersion += 1;
    entry.updatedAt = Date.now();
  }
}

export type ModelSwitchRestoreAction =
  | {
      action: "restore";
      lock: ContextLock;
    }
  | { action: "none" }
  | { action: "expired" };

/**
 * Determine what to do with the context lock on model switch.
 * Called after applyModelOverrideToSessionEntry().
 *
 * Returns:
 * - "restore": lock is active, caller should restore browser context + validate shop
 * - "expired": lock was expired and cleared
 * - "none": no lock present
 */
export function resolveModelSwitchRestore(entry: SessionEntry): ModelSwitchRestoreAction {
  const check = checkContextLock(entry);
  switch (check.status) {
    case "active":
      return { action: "restore", lock: check.lock };
    case "expired":
      return { action: "expired" };
    case "none":
      return { action: "none" };
  }
}
