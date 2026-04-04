/**
 * Crash recovery for active sessions.
 *
 * When the process crashes unexpectedly (not a graceful SIGUSR1 restart),
 * active sessions don't get marked with `abortedLastRun: true`. This module
 * provides a best-effort mechanism to mark sessions as aborted on crash,
 * so they can be recovered on next startup.
 *
 * Limitations:
 * - Synchronous file writes on exit are best-effort; extreme crashes (SIGKILL,
 *   power loss, OOM kill) may not complete the write.
 * - Only marks sessions that were registered as active before the crash.
 */

import fsSync from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("session-crash-recovery");

const CRASH_MARKER_FILENAME = "active-sessions-crash.json";

let registeredSessions = new Map<string, { sessionKey: string; updatedAt: number }>();
let crashMarkerPath: string | null = null;

/**
 * Initialize crash recovery system. Must be called during gateway startup.
 */
export function initSessionCrashRecovery(): void {
  try {
    const stateDir = resolveStateDir(process.env);
    crashMarkerPath = path.join(stateDir, CRASH_MARKER_FILENAME);

    // Recover any sessions marked as active from previous crash
    recoverFromCrashMarker(stateDir);

    // Install exit handlers
    installExitHandlers();
  } catch (err) {
    log.warn(`failed to initialize crash recovery: ${String(err)}`);
  }
}

/**
 * Register a session as active for crash recovery tracking.
 */
export function registerActiveSession(sessionKey: string): void {
  if (!sessionKey || !sessionKey.trim()) {
    return;
  }
  registeredSessions.set(sessionKey, {
    sessionKey,
    updatedAt: Date.now(),
  });
}

/**
 * Unregister a session when it completes normally.
 */
export function unregisterActiveSession(sessionKey: string): void {
  registeredSessions.delete(sessionKey);
}

/**
 * Clear all registered sessions (used on graceful shutdown).
 */
export function clearActiveSessions(): void {
  registeredSessions.clear();
}

function installExitHandlers(): void {
  // Write crash marker on unexpected exit
  const writeCrashMarker = () => {
    if (registeredSessions.size === 0 || !crashMarkerPath) {
      return;
    }
    try {
      const snapshot: { sessions: Array<{ sessionKey: string; updatedAt: number }> } = {
        sessions: Array.from(registeredSessions.values()),
      };
      fsSync.writeFileSync(crashMarkerPath, JSON.stringify(snapshot, null, 2), "utf8");
      log.info(`wrote crash marker with ${registeredSessions.size} active sessions`);
    } catch (err) {
      log.warn(`failed to write crash marker: ${String(err)}`);
    }
  };

  process.on("exit", () => {
    writeCrashMarker();
  });

  process.on("SIGINT", () => {
    // Graceful shutdown - clear marker since we're exiting intentionally
    clearActiveSessions();
    writeCrashMarker();
    process.exit(130);
  });

  process.on("SIGTERM", () => {
    // Graceful shutdown - clear marker since we're exiting intentionally
    clearActiveSessions();
    writeCrashMarker();
    process.exit(143);
  });
}

function recoverFromCrashMarker(stateDir: string): void {
  const markerPath = path.join(stateDir, CRASH_MARKER_FILENAME);
  if (!fsSync.existsSync(markerPath)) {
    return;
  }

  try {
    const content = fsSync.readFileSync(markerPath, "utf8");
    const snapshot = JSON.parse(content) as { sessions: Array<{ sessionKey: string }> };
    const markerPathToDelete = markerPath;

    if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length === 0) {
      fsSync.unlinkSync(markerPath);
      return;
    }

    log.info(`found crash marker with ${snapshot.sessions.length} sessions to recover`);

    // Mark sessions as aborted in their respective stores
    const cfg = loadConfig();
    const processedStores = new Set<string>();

    for (const { sessionKey } of snapshot.sessions) {
      try {
        const agentId = resolveAgentIdFromSessionKey(sessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });

        // Avoid redundant writes if we already processed this store
        if (!processedStores.has(storePath)) {
          processedStores.add(storePath);
        }

        const store = loadSessionStore(storePath);
        const entry = store[sessionKey];
        if (entry && !entry.endedAt) {
          // Only mark as aborted if session hasn't ended
          entry.abortedLastRun = true;
          entry.updatedAt = Date.now();
          store[sessionKey] = entry;

          void updateSessionStore(storePath, (s) => {
            s[sessionKey] = entry;
          });

          log.info(`marked session ${sessionKey} as aborted (crash recovery)`);
        }
      } catch (err) {
        log.warn(`failed to mark session ${sessionKey} as aborted: ${String(err)}`);
      }
    }

    // Clean up marker file after processing
    try {
      fsSync.unlinkSync(markerPathToDelete);
      log.info("removed crash marker file");
    } catch (err) {
      log.warn(`failed to remove crash marker: ${String(err)}`);
    }
  } catch (err) {
    log.warn(`failed to recover from crash marker: ${String(err)}`);
  }
}

function writeCrashMarkerSync(markerPath: string): void {
  if (registeredSessions.size === 0) {
    return;
  }
  const snapshot: { sessions: Array<{ sessionKey: string; updatedAt: number }> } = {
    sessions: Array.from(registeredSessions.values()),
  };
  fsSync.writeFileSync(markerPath, JSON.stringify(snapshot, null, 2), "utf8");
}

export const __testing = {
  resetForTest() {
    registeredSessions.clear();
    crashMarkerPath = null;
  },
  getRegisteredSessions() {
    return new Map(registeredSessions);
  },
  writeCrashMarkerSync(markerPath: string) {
    writeCrashMarkerSync(markerPath);
  },
  recoverFromCrashMarkerSync(stateDir: string) {
    recoverFromCrashMarker(stateDir);
  },
};
