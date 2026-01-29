import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import { loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";
import { isSessionActive, cleanupStaleActiveSessions } from "./active-sessions.js";
import { createSessionCheckpoint, cleanupOldCheckpoints } from "./checkpoint.js";

// Simple logger for session GC
const log = {
  info: (msg: string) => console.log(`[session-gc] ${msg}`),
  warn: (msg: string) => console.warn(`[session-gc] ${msg}`),
  error: (msg: string) => console.error(`[session-gc] ${msg}`),
};

export type SessionGCConfig = {
  enabled: boolean;
  maxAgeDays: number;
  keepMinSessions: number;
  runIntervalMinutes: number;
  cleanTranscripts: boolean;
  maxSessionDurationHours?: number; // Optional: reset sessions running longer than this
};

export type SessionGCResult = {
  agentsScanned: number;
  sessionsDeleted: number;
  transcriptsDeleted: number;
  sessionsReset: number; // Sessions reset due to duration limit
  errors: string[];
  durationMs: number;
};

const DEFAULT_GC_CONFIG: SessionGCConfig = {
  enabled: true,
  maxAgeDays: 7,
  keepMinSessions: 5,
  runIntervalMinutes: 60,
  cleanTranscripts: true,
  maxSessionDurationHours: 8, // Reset sessions running longer than 8 hours
};

export function resolveSessionGCConfig(cfg?: Partial<SessionGCConfig>): SessionGCConfig {
  return {
    ...DEFAULT_GC_CONFIG,
    ...cfg,
  };
}

/**
 * Run session garbage collection across all agents.
 * Deletes sessions older than maxAgeDays but preserves at least keepMinSessions per agent.
 * Optionally resets sessions that have been running longer than maxSessionDurationHours.
 */
export async function runSessionGC(opts: {
  maxAgeDays: number;
  keepMinSessions: number;
  cleanTranscripts?: boolean;
  maxSessionDurationHours?: number;
  dryRun?: boolean;
}): Promise<SessionGCResult> {
  const startedAt = Date.now();
  const result: SessionGCResult = {
    agentsScanned: 0,
    sessionsDeleted: 0,
    transcriptsDeleted: 0,
    sessionsReset: 0,
    errors: [],
    durationMs: 0,
  };

  const stateDir = resolveUserPath("~/.moltbot");
  const agentsDir = path.join(stateDir, "agents");

  try {
    // Check if agents directory exists
    try {
      await fs.access(agentsDir);
    } catch {
      log.info(`agents directory not found: ${agentsDir}`);
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // Scan all agent directories
    const agentDirEntries = await fs.readdir(agentsDir, { withFileTypes: true });
    const agentIds = agentDirEntries.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const agentId of agentIds) {
      result.agentsScanned++;
      try {
        const gcStats = await runSessionGCForAgent(agentId, opts);
        result.sessionsDeleted += gcStats.sessionsDeleted;
        result.transcriptsDeleted += gcStats.transcriptsDeleted;
        result.sessionsReset += gcStats.sessionsReset;

        // Clean up old checkpoints (same max age as sessions)
        if (!opts.dryRun) {
          try {
            await cleanupOldCheckpoints(agentId, opts.maxAgeDays);
          } catch (cleanupErr) {
            log.error(`Failed to cleanup checkpoints for agent ${agentId}: ${String(cleanupErr)}`);
          }
        }
      } catch (err) {
        const errMsg = `Failed to run GC for agent ${agentId}: ${String(err)}`;
        log.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    result.durationMs = Date.now() - startedAt;

    if (!opts.dryRun) {
      log.info(
        `completed: ${result.sessionsDeleted} deleted, ${result.sessionsReset} reset, ${result.transcriptsDeleted} transcripts, ${result.agentsScanned} agents (${result.durationMs}ms)`,
      );
    } else {
      log.info(
        `dry run: would delete ${result.sessionsDeleted}, reset ${result.sessionsReset} sessions from ${result.agentsScanned} agents`,
      );
    }

    return result;
  } catch (err) {
    const errMsg = `Session GC failed: ${String(err)}`;
    log.error(errMsg);
    result.errors.push(errMsg);
    result.durationMs = Date.now() - startedAt;
    return result;
  }
}

async function runSessionGCForAgent(
  agentId: string,
  opts: {
    maxAgeDays: number;
    keepMinSessions: number;
    cleanTranscripts?: boolean;
    maxSessionDurationHours?: number;
    dryRun?: boolean;
  },
): Promise<{ sessionsDeleted: number; transcriptsDeleted: number; sessionsReset: number }> {
  const stats = { sessionsDeleted: 0, transcriptsDeleted: 0, sessionsReset: 0 };

  const stateDir = resolveUserPath("~/.moltbot");
  const agentDir = path.join(stateDir, "agents", agentId);
  const sessionsDir = path.join(agentDir, "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");

  // Check if sessions.json exists
  try {
    await fs.access(storePath);
  } catch {
    // No sessions store for this agent
    return stats;
  }

  // Load session store
  const store = loadSessionStore(storePath, { skipCache: true });
  const sessions = Object.entries(store);

  if (sessions.length === 0) {
    return stats;
  }

  // Calculate cutoff timestamp
  const maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - maxAgeMs;

  // Sort sessions by updatedAt (newest first)
  const sortedSessions = sessions.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));

  // Clean up stale entries from active sessions registry before checking
  cleanupStaleActiveSessions();

  // Identify sessions to delete
  const sessionsToDelete: Array<[string, SessionEntry]> = [];
  const skippedActiveSessions: string[] = [];

  for (let i = 0; i < sortedSessions.length; i++) {
    const [key, entry] = sortedSessions[i];
    const age = entry.updatedAt ?? 0;

    // Skip if session is newer than cutoff
    if (age >= cutoffTime) continue;

    // CRITICAL: Skip if session is currently active
    if (isSessionActive(key)) {
      skippedActiveSessions.push(key);
      log.info(`agent=${agentId}: skipping active session ${key}`);
      continue;
    }

    // Skip if deleting would violate keepMinSessions constraint
    const remainingCount = sortedSessions.length - sessionsToDelete.length;
    if (remainingCount <= opts.keepMinSessions) {
      break;
    }

    sessionsToDelete.push([key, entry]);
  }

  if (skippedActiveSessions.length > 0) {
    log.info(`agent=${agentId}: skipped ${skippedActiveSessions.length} active sessions during GC`);
  }

  // Handle duration-based resets (reset sessions running too long by archiving transcript)
  if (opts.maxSessionDurationHours && opts.maxSessionDurationHours > 0) {
    const maxDurationMs = opts.maxSessionDurationHours * 60 * 60 * 1000;

    for (const [key, entry] of sessions) {
      // Skip sessions that are already scheduled for deletion
      if (sessionsToDelete.some(([k]) => k === key)) continue;

      if (!entry.sessionId) continue;

      const transcriptPath = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
      try {
        // Check if transcript file exists and get its creation time
        const fileStat = await fs.stat(transcriptPath);
        const fileAge = Date.now() - fileStat.birthtimeMs;

        if (fileAge > maxDurationMs) {
          // This session has been running longer than the duration limit
          // Reset it by archiving the transcript file (the session will start fresh)
          if (!opts.dryRun) {
            const archiveName = `${entry.sessionId}.jsonl.reset.${Date.now()}`;
            await fs.rename(transcriptPath, path.join(sessionsDir, archiveName));
            log.info(
              `agent=${agentId}: reset long-running session ${entry.sessionId} (${Math.round(fileAge / 3600000)}h old)`,
            );
          }
          stats.sessionsReset++;
        }
      } catch {
        // Transcript doesn't exist or can't be accessed, skip
      }
    }
  }

  if (sessionsToDelete.length === 0 && stats.sessionsReset === 0) {
    return stats;
  }

  // Create checkpoints before deletion (enables recovery)
  if (!opts.dryRun && sessionsToDelete.length > 0) {
    for (const [key, entry] of sessionsToDelete) {
      try {
        await createSessionCheckpoint(agentId, key, entry, "pre-gc");
        log.info(`agent=${agentId}: created checkpoint for session ${key} before GC deletion`);
      } catch (checkpointErr) {
        log.error(
          `agent=${agentId}: failed to create checkpoint for session ${key}: ${String(checkpointErr)}`,
        );
        // Continue with deletion even if checkpoint fails
      }
    }
  }

  // Delete sessions from store
  if (!opts.dryRun && sessionsToDelete.length > 0) {
    for (const [key] of sessionsToDelete) {
      delete store[key];
    }
    await saveSessionStore(storePath, store);
  }

  stats.sessionsDeleted = sessionsToDelete.length;

  // Clean up transcript files if enabled
  if (opts.cleanTranscripts !== false) {
    for (const [, entry] of sessionsToDelete) {
      if (entry.sessionId) {
        const transcriptPath = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
        try {
          if (!opts.dryRun) {
            await fs.unlink(transcriptPath);
          }
          stats.transcriptsDeleted++;
        } catch {
          // Ignore errors (file might not exist)
        }
      }
    }

    // Also scan for orphaned transcripts (JSONL files without matching session entries)
    try {
      const files = await fs.readdir(sessionsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      const validSessionIds = new Set(Object.values(store).map((e) => e.sessionId));

      for (const file of jsonlFiles) {
        const sessionId = path.basename(file, ".jsonl");
        if (!validSessionIds.has(sessionId)) {
          const orphanedPath = path.join(sessionsDir, file);
          try {
            if (!opts.dryRun) {
              await fs.unlink(orphanedPath);
            }
            stats.transcriptsDeleted++;
          } catch {
            // Ignore errors
          }
        }
      }
    } catch {
      // Ignore directory scan errors
    }
  }

  if (!opts.dryRun && stats.sessionsDeleted > 0) {
    log.info(
      `agent=${agentId}: deleted ${stats.sessionsDeleted} sessions, ${stats.transcriptsDeleted} transcripts`,
    );
  }

  return stats;
}

/**
 * Start background task to run session GC periodically.
 * Returns cleanup function to stop the task.
 */
export function startSessionGCTask(config: SessionGCConfig): () => void {
  if (!config.enabled) {
    log.info("disabled by config");
    return () => {};
  }

  const intervalMs = config.runIntervalMinutes * 60 * 1000;

  log.info(
    `starting background task: maxAgeDays=${config.maxAgeDays}, keepMin=${config.keepMinSessions}, maxDuration=${config.maxSessionDurationHours ?? "unlimited"}h, interval=${config.runIntervalMinutes}m`,
  );

  // Run initial GC after a short delay to avoid blocking startup
  const initialDelay = 30_000; // 30 seconds
  const initialTimer = setTimeout(() => {
    runSessionGC({
      maxAgeDays: config.maxAgeDays,
      keepMinSessions: config.keepMinSessions,
      cleanTranscripts: config.cleanTranscripts,
      maxSessionDurationHours: config.maxSessionDurationHours,
      dryRun: false,
    }).catch((err) => {
      log.error(`initial run failed: ${String(err)}`);
    });
  }, initialDelay);

  // Schedule periodic runs
  const interval = setInterval(() => {
    runSessionGC({
      maxAgeDays: config.maxAgeDays,
      keepMinSessions: config.keepMinSessions,
      cleanTranscripts: config.cleanTranscripts,
      maxSessionDurationHours: config.maxSessionDurationHours,
      dryRun: false,
    }).catch((err) => {
      log.error(`periodic run failed: ${String(err)}`);
    });
  }, intervalMs);

  // Don't prevent process exit
  interval.unref();

  // Return cleanup function
  return () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
    log.info("stopped");
  };
}
