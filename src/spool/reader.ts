/**
 * Spool event reader - reads and validates event files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SpoolEvent } from "./types.js";
import { resolveSpoolEventsDir, resolveSpoolEventPath } from "./paths.js";
import { validateSpoolEvent } from "./schema.js";

export type ReadSpoolEventResult =
  | { success: true; event: SpoolEvent }
  | { success: false; error: string };

/**
 * Read and validate a spool event from a file path.
 */
export async function readSpoolEventFile(filePath: string): Promise<ReadSpoolEventResult> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content);
    const validation = validateSpoolEvent(data);
    if (!validation.valid) {
      return { success: false, error: `validation failed: ${validation.error}` };
    }
    return { success: true, event: validation.event as SpoolEvent };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { success: false, error: "file not found" };
    }
    return { success: false, error: `read error: ${String(err)}` };
  }
}

/**
 * Read a spool event by ID.
 */
export async function readSpoolEvent(
  eventId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ReadSpoolEventResult> {
  const eventPath = resolveSpoolEventPath(eventId, env);
  return readSpoolEventFile(eventPath);
}

/**
 * List all pending event IDs in the spool directory.
 */
export async function listSpoolEventIds(
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const eventsDir = resolveSpoolEventsDir(env);
  try {
    const files = await fs.readdir(eventsDir);
    return files
      .filter((f) => f.endsWith(".json") && !f.includes(".json.tmp."))
      .map((f) => path.basename(f, ".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * List all pending events, sorted by priority and creation time.
 */
export async function listSpoolEvents(
  env: Record<string, string | undefined> = process.env,
): Promise<SpoolEvent[]> {
  const ids = await listSpoolEventIds(env);
  const events: SpoolEvent[] = [];

  for (const id of ids) {
    const result = await readSpoolEvent(id, env);
    if (result.success) {
      events.push(result.event);
    }
  }

  // Sort by priority (critical > high > normal > low) then by createdAtMs (oldest first)
  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };

  return events.toSorted((a, b) => {
    const aPriority = priorityOrder[a.priority ?? "normal"] ?? 2;
    const bPriority = priorityOrder[b.priority ?? "normal"] ?? 2;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return a.createdAtMs - b.createdAtMs;
  });
}

/**
 * Delete a spool event file.
 */
export async function deleteSpoolEvent(
  eventId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
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
 * Count pending events.
 */
export async function countSpoolEvents(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const ids = await listSpoolEventIds(env);
  return ids.length;
}
