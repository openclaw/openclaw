/**
 * Periodic session store cleanup — prunes idle/stale sessions across all
 * agent session stores. Designed to run at gateway startup and on a periodic
 * interval (every 5 minutes) so zombie sessions don't accumulate.
 *
 * Sessions are considered idle when their `updatedAt` timestamp is older than
 * the configured `pruneAfter` threshold (default: 24 hours). Active usage
 * (chat turns, agent runs, etc.) resets `updatedAt` automatically, so only
 * truly idle sessions are cleaned up.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
  updateSessionStore,
} from "../config/sessions.js";
import {
  capEntryCount,
  pruneStaleEntries,
  resolveMaintenanceConfig,
} from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { cleanupArchivedSessionTranscripts } from "./session-utils.fs.js";

/** Minimum interval between sweeps to avoid excessive I/O. */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

let lastSweepAtMs = 0;

export type SessionCleanupLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type SweepIdleSessionsResult = {
  swept: boolean;
  totalPruned: number;
  storesChecked: number;
};

/**
 * Sweep all agent session stores and prune idle/stale entries.
 *
 * Self-throttled to run at most once every 5 minutes. Pass `force: true`
 * to bypass the throttle (e.g. on gateway startup).
 */
export async function sweepIdleSessions(params: {
  stateDir: string;
  log: SessionCleanupLog;
  force?: boolean;
  nowMs?: number;
}): Promise<SweepIdleSessionsResult> {
  const now = params.nowMs ?? Date.now();

  // Throttle: skip if swept recently (unless forced).
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, totalPruned: 0, storesChecked: 0 };
  }

  const maintenance = resolveMaintenanceConfig();

  // Only sweep when mode is "enforce"; in "warn" mode the write-time
  // maintenance path handles warnings instead.
  if (maintenance.mode === "warn") {
    lastSweepAtMs = now;
    return { swept: false, totalPruned: 0, storesChecked: 0 };
  }

  const sessionDirs = await resolveAgentSessionDirs(params.stateDir);
  let totalPruned = 0;
  let storesChecked = 0;

  for (const sessionsDir of sessionDirs) {
    const storePath = path.join(sessionsDir, "sessions.json");

    // Skip if store file doesn't exist.
    try {
      await fs.promises.access(storePath, fs.constants.F_OK);
    } catch {
      continue;
    }

    storesChecked++;

    try {
      const removedSessionFiles = new Map<string, string | undefined>();

      await updateSessionStore(
        storePath,
        (store) => {
          const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
            log: false,
            onPruned: ({ entry }) => {
              rememberRemovedSessionFile(removedSessionFiles, entry);
            },
          });
          capEntryCount(store, maintenance.maxEntries, {
            log: false,
            onCapped: ({ entry }) => {
              rememberRemovedSessionFile(removedSessionFiles, entry);
            },
          });
          totalPruned += pruned;
        },
        { skipMaintenance: true },
      );

      // Archive transcripts for removed sessions.
      if (removedSessionFiles.size > 0) {
        try {
          const store = loadSessionStore(storePath, { skipCache: true });
          const referencedSessionIds = new Set(
            Object.values(store)
              .map((entry) => entry?.sessionId)
              .filter((id): id is string => Boolean(id)),
          );
          const archivedDirs = archiveRemovedSessionTranscripts({
            removedSessionFiles,
            referencedSessionIds,
            storePath,
            reason: "deleted",
            restrictToStoreDir: true,
          });
          if (archivedDirs.size > 0) {
            await cleanupArchivedSessionTranscripts({
              directories: [...archivedDirs],
              olderThanMs: maintenance.pruneAfterMs,
              reason: "deleted",
              nowMs: now,
            });
          }
        } catch (err) {
          params.log.warn(`session-cleanup: transcript archival failed: ${String(err)}`);
        }
      }
    } catch (err) {
      params.log.warn(`session-cleanup: failed to sweep ${storePath}: ${String(err)}`);
    }
  }

  lastSweepAtMs = now;

  if (totalPruned > 0) {
    params.log.info(
      `session-cleanup: pruned ${totalPruned} idle session(s) from ${storesChecked} store(s)`,
    );
  }

  return { swept: true, totalPruned, storesChecked };
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

/** Reset the sweep throttle (for tests). */
export function resetSessionCleanupThrottle(): void {
  lastSweepAtMs = 0;
}
