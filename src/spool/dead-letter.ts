/**
 * Spool dead-letter handling - manages failed events.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SpoolEvent } from "./types.js";
import {
  resolveSpoolDeadLetterDir,
  resolveSpoolDeadLetterPath,
  resolveSpoolEventPath,
} from "./paths.js";

/**
 * Ensure the dead-letter directory exists.
 */
export async function ensureSpoolDeadLetterDir(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const dir = resolveSpoolDeadLetterDir(env);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export type DeadLetterReason = "max_retries" | "invalid" | "expired" | "error";

export type DeadLetterEntry = {
  event: SpoolEvent | null;
  reason: DeadLetterReason;
  error?: string;
  movedAt: string;
  movedAtMs: number;
  originalPath: string;
};

/**
 * Move an event to the dead-letter directory.
 */
export async function moveToDeadLetter(
  eventId: string,
  event: SpoolEvent | null,
  reason: DeadLetterReason,
  error?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await ensureSpoolDeadLetterDir(env);

  const now = Date.now();
  const entry: DeadLetterEntry = {
    event,
    reason,
    error,
    movedAt: new Date(now).toISOString(),
    movedAtMs: now,
    originalPath: resolveSpoolEventPath(eventId, env),
  };

  const deadLetterPath = resolveSpoolDeadLetterPath(eventId, env);
  await fs.writeFile(deadLetterPath, JSON.stringify(entry, null, 2), "utf8");

  // Remove from events directory
  const eventPath = resolveSpoolEventPath(eventId, env);
  try {
    await fs.unlink(eventPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * List dead-letter event IDs.
 */
export async function listDeadLetterIds(
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const dir = resolveSpoolDeadLetterDir(env);
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Read a dead-letter entry.
 */
export async function readDeadLetterEntry(
  eventId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DeadLetterEntry | null> {
  const deadLetterPath = resolveSpoolDeadLetterPath(eventId, env);
  try {
    const content = await fs.readFile(deadLetterPath, "utf8");
    return JSON.parse(content) as DeadLetterEntry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Count dead-letter events.
 */
export async function countDeadLetterEvents(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const ids = await listDeadLetterIds(env);
  return ids.length;
}

/**
 * Clear all dead-letter events.
 */
export async function clearDeadLetterEvents(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const ids = await listDeadLetterIds(env);
  const dir = resolveSpoolDeadLetterDir(env);
  let cleared = 0;

  for (const id of ids) {
    try {
      await fs.unlink(path.join(dir, `${id}.json`));
      cleared++;
    } catch {
      // Ignore errors
    }
  }

  return cleared;
}
