// Migrates the retired live-chat-followup-queues.json sidecar into shared SQLite state.
import fs from "node:fs";
import path from "node:path";
import { LEGACY_FOLLOWUP_QUEUE_STATE_FILENAME } from "../auto-reply/reply/queue/persist.js";
import { loadFollowupQueueEntries, replaceFollowupQueueEntries } from "./followup-queue-sqlite.js";
import { fileExists } from "./state-migrations.fs.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

export function resolveLegacyFollowupQueueStatePath(stateDir: string): string {
  return path.join(stateDir, LEGACY_FOLLOWUP_QUEUE_STATE_FILENAME);
}

/** Detect a retired followup-queue JSON sidecar left over from before SQLite persistence. */
export function detectLegacyFollowupQueueSidecar(params: {
  stateDir: string;
}): LegacyStateDetection["followupQueueSidecar"] {
  const sourcePath = resolveLegacyFollowupQueueStatePath(params.stateDir);
  return {
    sourcePath,
    hasLegacy: fileExists(sourcePath),
  };
}

/**
 * Import entries from the legacy JSON sidecar into shared SQLite state, then remove the
 * sidecar. Entries already present in SQLite win on conflict — the sidecar is left in place
 * (with a warning) so no data is silently dropped.
 */
export async function migrateLegacyFollowupQueueSidecar(params: {
  detected: LegacyStateDetection["followupQueueSidecar"];
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }
  const sourcePath = params.detected.sourcePath;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (err) {
    warnings.push(`Failed reading followup queue sidecar ${sourcePath}: ${String(err)}`);
    return { changes, warnings };
  }

  const entriesRaw = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entriesRaw)) {
    warnings.push(`Skipped malformed followup queue sidecar ${sourcePath}`);
    return { changes, warnings };
  }

  const jsonEntries = new Map<string, unknown>();
  for (const entry of entriesRaw) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const key = typeof entry[0] === "string" ? entry[0] : undefined;
    if (!key) {
      continue;
    }
    jsonEntries.set(key, entry[1]);
  }

  if (jsonEntries.size === 0) {
    try {
      fs.rmSync(sourcePath, { force: true });
      changes.push(`Removed empty followup queue sidecar ${sourcePath}`);
    } catch (err) {
      warnings.push(`Failed removing empty followup queue sidecar ${sourcePath}: ${String(err)}`);
    }
    return { changes, warnings };
  }

  let existingEntries: Array<[string, unknown]>;
  try {
    existingEntries = loadFollowupQueueEntries(params.stateDir);
  } catch (err) {
    warnings.push(`Failed reading shared SQLite followup queue state: ${String(err)}`);
    return { changes, warnings };
  }

  const existingMap = new Map(existingEntries);
  const conflicts: string[] = [];
  const mergedEntries: Array<[string, unknown]> = [...existingEntries];
  let imported = 0;

  for (const [key, queueData] of jsonEntries) {
    const existing = existingMap.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(queueData)) {
        conflicts.push(key);
      }
      continue;
    }
    mergedEntries.push([key, queueData]);
    imported++;
  }

  if (conflicts.length > 0) {
    warnings.push(
      `Left followup queue sidecar in place because ${conflicts.length} ${conflicts.length === 1 ? "entry" : "entries"} already existed in shared state with different data: ${conflicts[0]}`,
    );
    return { changes, warnings };
  }

  try {
    replaceFollowupQueueEntries({ entries: mergedEntries, stateDir: params.stateDir });
  } catch (err) {
    warnings.push(`Failed migrating followup queue sidecar ${sourcePath}: ${String(err)}`);
    return { changes, warnings };
  }

  try {
    fs.rmSync(sourcePath, { force: true });
    if (imported > 0) {
      changes.push(
        `Migrated ${imported} followup queue ${imported === 1 ? "entry" : "entries"} → shared SQLite state`,
      );
    } else {
      changes.push(`Removed superseded followup queue sidecar ${sourcePath}`);
    }
  } catch (err) {
    warnings.push(`Migrated followup queues but failed removing ${sourcePath}: ${String(err)}`);
  }

  return { changes, warnings };
}
