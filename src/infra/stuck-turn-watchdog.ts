import { isEmbeddedPiRunActive, abortEmbeddedPiRun } from "../agents/pi-embedded-runner/runs.js";
import type { CliDeps } from "../cli/deps.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadActiveTurnMarkers, removeActiveTurnMarker } from "./active-turns.js";

const log = createSubsystemLogger("stuck-turn-watchdog");

/** Default: check every 2 minutes. */
const DEFAULT_CHECK_INTERVAL_MS = 120_000;
/** Warn after 10 minutes. */
const DEFAULT_WARN_AFTER_MS = 600_000;
/** Abort after 20 minutes. */
const DEFAULT_ABORT_AFTER_MS = 1_200_000;

export type StuckTurnWatchdogHandle = {
  stop: () => void;
};

/**
 * Start a periodic watchdog that detects agent turns running abnormally long.
 *
 * On each tick the watchdog scans active turn markers on disk:
 * - Marker exists but no in-memory run → stale leftover, clean it up.
 * - Active run older than `abortAfterMs` → abort the run.
 * - Active run older than `warnAfterMs` → log a warning.
 */
export function startStuckTurnWatchdog(params: {
  deps: CliDeps;
  checkIntervalMs?: number;
  warnAfterMs?: number;
  abortAfterMs?: number;
}): StuckTurnWatchdogHandle {
  const checkIntervalMs = params.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const warnAfterMs = params.warnAfterMs ?? DEFAULT_WARN_AFTER_MS;
  const abortAfterMs = params.abortAfterMs ?? DEFAULT_ABORT_AFTER_MS;

  const timer = setInterval(() => {
    void checkStuckTurns({ warnAfterMs, abortAfterMs }).catch((err) => {
      log.warn(`watchdog tick failed: ${String(err)}`);
    });
  }, checkIntervalMs);

  // Prevent the interval from keeping the process alive during shutdown.
  if (timer.unref) {
    timer.unref();
  }

  log.info(
    `started (checkInterval=${checkIntervalMs}ms warn=${warnAfterMs}ms abort=${abortAfterMs}ms)`,
  );

  return {
    stop: () => {
      clearInterval(timer);
      log.info("stopped");
    },
  };
}

async function checkStuckTurns(opts: { warnAfterMs: number; abortAfterMs: number }): Promise<void> {
  const markers = await loadActiveTurnMarkers();
  if (markers.length === 0) {
    return;
  }

  const now = Date.now();
  for (const marker of markers) {
    const elapsed = now - marker.startedAt;
    const isActive = isEmbeddedPiRunActive(marker.sessionId);

    if (!isActive) {
      // Stale marker: the in-memory run is gone (process restarted or run
      // completed but clearActiveTurn failed). Clean it up silently.
      await removeActiveTurnMarker(marker.sessionId);
      log.info(`cleaned stale marker: sessionId=${marker.sessionId}`);
      continue;
    }

    if (elapsed >= opts.abortAfterMs) {
      log.warn(
        `aborting stuck turn: sessionId=${marker.sessionId} sessionKey=${marker.sessionKey} elapsed=${elapsed}ms`,
      );
      abortEmbeddedPiRun(marker.sessionId);
      // The abort triggers clearActiveEmbeddedRun which calls clearActiveTurn,
      // so we do not need to remove the marker here.
      continue;
    }

    if (elapsed >= opts.warnAfterMs) {
      log.warn(
        `stuck turn detected: sessionId=${marker.sessionId} sessionKey=${marker.sessionKey} elapsed=${elapsed}ms`,
      );
    }
  }
}
