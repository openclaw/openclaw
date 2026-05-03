/**
 * Reset stale "running" sessions on gateway startup.
 *
 * When the gateway restarts, sessions that were in "running" status remain stuck
 * because there's no active process to complete them. The lock-based cleanup
 * in `server-startup-post-attach.ts` only catches sessions that had a `.lock`
 * file at restart time. Sessions between lock acquire/release or those with
 * in-memory-only state are missed, causing ~20 min of blocked runs until the
 * periodic prune cycle clears them.
 *
 * This module scans all session stores and marks any stale "running" entries as
 * "failed" with `abortedLastRun=true`, so the existing
 * `scheduleRestartAbortedMainSessionRecovery` mechanism can attempt to resume
 * them.
 *
 * When called from gateway startup (`resetAllRunning=true`), ALL running
 * sessions are reset regardless of `updatedAt` — since the gateway just
 * restarted, no process is alive to complete them, so "recently updated" sessions
 * are just as stale as old ones.
 */

import path from "node:path";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { resolveStateDir } from "../config/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("stale-session-reset");

/**
 * The maximum age (ms) for a "running" session to still be considered active
 * after a gateway restart. Sessions with `updatedAt` newer than this threshold
 * are left alone (they may have been started by a process that survived restart).
 * Sessions older than this are reset to "failed".
 *
 * This is intentionally short (2 min) because the gateway just restarted — any
 * session updated more than 2 min before restart is definitely stale.
 *
 * NOTE: This threshold is only used for periodic/maintenance resets (not startup).
 * At gateway startup, `resetAllRunning=true` is passed, which bypasses the
 * timestamp check entirely since no process can be alive after a restart.
 */
const STALE_RUNNING_THRESHOLD_MS = 2 * 60 * 1000;

export type StaleSessionResetResult = {
  /** Number of session stores scanned. */
  storesScanned: number;
  /** Total "running" sessions found across all stores. */
  runningCount: number;
  /** Sessions reset from "running" to "failed". */
  resetCount: number;
  /** Sessions skipped (subagent/cron/ACP, or too recent in threshold mode). */
  skippedCount: number;
};

/**
 * Whether a session should be skipped from stale-reset.
 * Subagent, cron, and ACP sessions have their own recovery paths.
 */
export function shouldSkipStaleReset(entry: SessionEntry, sessionKey: string): boolean {
  // Subagent sessions are recovered by scheduleSubagentOrphanRecovery
  if (entry.subagentRole != null || (entry.spawnDepth ?? 0) > 0) {
    return true;
  }
  // Cron sessions have their own lifecycle
  if (sessionKey.includes(":cron:")) {
    return true;
  }
  // ACP sessions have their own reconcile path
  if (sessionKey.includes(":acp:")) {
    return true;
  }
  return false;
}

/**
 * Reset all stale "running" sessions across all session stores.
 * Called once at gateway startup after lock cleanup.
 *
 * When `resetAllRunning` is true, ALL non-skipped running sessions are reset
 * regardless of their `updatedAt` timestamp. This is appropriate at gateway
 * startup where no previous process is alive. See AGE-11858.
 */
export async function resetStaleRunningSessions(params?: {
  stateDir?: string;
  nowMs?: number;
  staleThresholdMs?: number;
  /** When true, reset ALL running sessions regardless of updatedAt. Use at startup. */
  resetAllRunning?: boolean;
  log?: {
    warn: (message: string) => void;
    info: (message: string) => void;
  };
}): Promise<StaleSessionResetResult> {
  const stateDir = params?.stateDir ?? resolveStateDir(process.env);
  const nowMs = params?.nowMs ?? Date.now();
  const resetAllRunning = params?.resetAllRunning ?? false;
  const staleThresholdMs = params?.staleThresholdMs ?? STALE_RUNNING_THRESHOLD_MS;
  const cutoffMs = nowMs - staleThresholdMs;
  const logger = params?.log ?? log;
  const result: StaleSessionResetResult = {
    storesScanned: 0,
    runningCount: 0,
    resetCount: 0,
    skippedCount: 0,
  };

  let sessionDirs: string[];
  try {
    sessionDirs = await resolveAgentSessionDirs(stateDir);
  } catch (err) {
    logger.warn(`stale-session-reset: failed to resolve session dirs: ${String(err)}`);
    return result;
  }

  for (const sessionsDir of sessionDirs) {
    const storePath = path.join(path.resolve(sessionsDir), "sessions.json");
    result.storesScanned++;

    try {
      const store = loadSessionStore(storePath);
      // First pass: count running entries and classify them.
      const keysToReset: string[] = [];
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry || entry.status !== "running") {
          continue;
        }
        result.runningCount++;
        if (shouldSkipStaleReset(entry, sessionKey)) {
          result.skippedCount++;
          continue;
        }
        if (!resetAllRunning && entry.updatedAt != null && entry.updatedAt > cutoffMs) {
          // Too recent — might still be alive. Skip only in threshold mode.
          // In startup mode (resetAllRunning=true), all running sessions are
          // stale because no process survived the restart.
          result.skippedCount++;
          continue;
        }
        keysToReset.push(sessionKey);
      }

      if (keysToReset.length === 0) {
        continue;
      }

      // Second pass: update the store.
      await updateSessionStore(
        storePath,
        (store) => {
          for (const sessionKey of keysToReset) {
            const entry = store[sessionKey];
            if (!entry || entry.status !== "running") {
              continue;
            }
            entry.status = "failed";
            entry.abortedLastRun = true;
            entry.endedAt = entry.endedAt ?? nowMs;
            entry.updatedAt = nowMs;
            store[sessionKey] = entry;
          }
        },
        { skipMaintenance: true },
      );
      result.resetCount += keysToReset.length;
    } catch (err) {
      logger.warn(`stale-session-reset: failed to process store ${storePath}: ${String(err)}`);
    }
  }

  if (result.resetCount > 0) {
    logger.info(
      `stale-session-reset: reset ${result.resetCount} stale running session(s) ` +
        `(found ${result.runningCount} running, skipped ${result.skippedCount})`,
    );
  }

  return result;
}
