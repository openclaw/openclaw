/**
 * Spool directory path resolution and file utilities.
 *
 * Spool uses a directory structure under ~/.openclaw/spool/:
 * - events/     : pending events waiting to be processed
 * - dead-letter/: failed events that exceeded retry limits
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveGatewayStateDir } from "../daemon/paths.js";

const SPOOL_SUBDIR = "spool";
const EVENTS_SUBDIR = "events";
const DEAD_LETTER_SUBDIR = "dead-letter";

/**
 * Get the base spool directory (~/.openclaw/spool/).
 */
export function resolveSpoolDir(env: Record<string, string | undefined> = process.env): string {
  const stateDir = resolveGatewayStateDir(env);
  return path.join(stateDir, SPOOL_SUBDIR);
}

/**
 * Get the events directory (~/.openclaw/spool/events/).
 */
export function resolveSpoolEventsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveSpoolDir(env), EVENTS_SUBDIR);
}

/**
 * Get the dead-letter directory (~/.openclaw/spool/dead-letter/).
 */
export function resolveSpoolDeadLetterDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveSpoolDir(env), DEAD_LETTER_SUBDIR);
}

/**
 * Get the full path for an event file.
 */
export function resolveSpoolEventPath(
  eventId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveSpoolEventsDir(env), `${eventId}.json`);
}

/**
 * Get the full path for a dead-letter file.
 */
export function resolveSpoolDeadLetterPath(
  eventId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveSpoolDeadLetterDir(env), `${eventId}.json`);
}

/**
 * List JSON file IDs in a directory.
 * Filters to .json files, excludes temp files (.json.tmp.*), and extracts IDs.
 */
export async function listJsonFileIds(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
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
