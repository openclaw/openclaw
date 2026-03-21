/**
 * Session Health — Periodic Timer Runner
 *
 * Follows the exact pattern established by `heartbeat-runner.ts`:
 * - Registers a `setTimeout` + `unref()` timer so it won't prevent clean shutdown.
 * - Runs the collector periodically and writes cached snapshots.
 * - First collection happens after a startup delay (not in the critical path).
 * - Config-reactive: can update the interval on config reload.
 */

import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  collectSessionHealth,
  pruneOldHistory,
  writeCachedDerivedSurface,
  writeCachedSnapshot,
  writeHistorySnapshot,
} from "./session-health-collector.js";
import { deriveSessionHealthSurface } from "./session-health-derive.js";

const log = createSubsystemLogger("session-health");

/** Default interval: 5 minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Startup delay: 30 seconds (don't block gateway startup). */
const STARTUP_DELAY_MS = 30_000;

export type SessionHealthRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

export function startSessionHealthCollector(opts?: {
  cfg?: OpenClawConfig;
  intervalMs?: number;
  startupDelayMs?: number;
}): SessionHealthRunner {
  const state = {
    cfg: opts?.cfg ?? loadConfig(),
    intervalMs: opts?.intervalMs ?? DEFAULT_INTERVAL_MS,
    timer: null as ReturnType<typeof setTimeout> | null,
    stopped: false,
    running: false,
  };

  const runCollection = async () => {
    if (state.stopped || state.running) {
      return;
    }
    state.running = true;
    try {
      const snapshot = await collectSessionHealth(state.cfg);
      await writeCachedSnapshot(snapshot);
      await writeHistorySnapshot(snapshot);
      await pruneOldHistory();

      // Derive and cache the operator-facing health surface (Layer B)
      const surface = deriveSessionHealthSurface(snapshot);
      await writeCachedDerivedSurface(surface);

      log.info("session health snapshot collected", {
        durationMs: snapshot.collectorDurationMs,
        indexed: snapshot.sessions.indexedCount,
        agents: snapshot.agents.length,
        overallLevel: surface.overallLevel,
      });
    } catch (err) {
      log.warn("session health collection failed", { error: String(err) });
    } finally {
      state.running = false;
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (state.stopped) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void runCollection();
    }, state.intervalMs);
    state.timer.unref?.();
  };

  // Schedule first run after startup delay
  state.timer = setTimeout(() => {
    state.timer = null;
    void runCollection();
  }, opts?.startupDelayMs ?? STARTUP_DELAY_MS);
  state.timer.unref?.();

  const stop = () => {
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    state.cfg = cfg;
  };

  return { stop, updateConfig };
}
