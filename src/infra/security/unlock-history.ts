/**
 * Unlock history storage
 *
 * Tracks unlock attempts for security auditing.
 */

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UnlockEvent, UnlockFailureReason } from "./types.js";
import { MAX_UNLOCK_HISTORY_ENTRIES } from "./types.js";

/** Directory for security data */
const SECURITY_DIR = ".clawdbrain/security";

/** Unlock history file name */
const UNLOCK_HISTORY_FILE = "unlock-history.json";

/**
 * Resolve the unlock history file path.
 */
export function resolveUnlockHistoryPath(homeDir: string): string {
  return join(homeDir, SECURITY_DIR, UNLOCK_HISTORY_FILE);
}

/**
 * Load unlock history from file.
 */
export async function loadUnlockHistory(historyPath: string): Promise<UnlockEvent[]> {
  try {
    const content = await readFile(historyPath, "utf-8");
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      return [];
    }

    return data as UnlockEvent[];
  } catch (error) {
    // File doesn't exist or is invalid
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    console.error("Failed to load unlock history:", error);
    return [];
  }
}

/**
 * Save unlock history to file.
 */
export async function saveUnlockHistory(historyPath: string, events: UnlockEvent[]): Promise<void> {
  // Ensure directory exists
  await mkdir(dirname(historyPath), { recursive: true });

  // Keep only the most recent entries
  const trimmed = events.slice(-MAX_UNLOCK_HISTORY_ENTRIES);

  await writeFile(historyPath, JSON.stringify(trimmed, null, 2), "utf-8");
}

/**
 * Record an unlock attempt.
 */
export async function recordUnlockAttempt(
  historyPath: string,
  event: Omit<UnlockEvent, "id" | "ts">,
): Promise<UnlockEvent> {
  const events = await loadUnlockHistory(historyPath);

  const newEvent: UnlockEvent = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...event,
  };

  events.push(newEvent);
  await saveUnlockHistory(historyPath, events);

  return newEvent;
}

/**
 * Get recent unlock attempts.
 */
export async function getUnlockHistory(
  historyPath: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ events: UnlockEvent[]; total: number }> {
  const { limit = 50, offset = 0 } = options;
  const events = await loadUnlockHistory(historyPath);

  // Sort by timestamp descending (newest first)
  const sorted = events.sort((a, b) => b.ts - a.ts);

  return {
    events: sorted.slice(offset, offset + limit),
    total: sorted.length,
  };
}

/**
 * Create a successful unlock event.
 */
export function createSuccessEvent(
  ipAddress?: string,
  userAgent?: string,
): Omit<UnlockEvent, "id" | "ts"> {
  return {
    success: true,
    ipAddress,
    userAgent,
  };
}

/**
 * Create a failed unlock event.
 */
export function createFailureEvent(
  failureReason: UnlockFailureReason,
  ipAddress?: string,
  userAgent?: string,
): Omit<UnlockEvent, "id" | "ts"> {
  return {
    success: false,
    failureReason,
    ipAddress,
    userAgent,
  };
}
