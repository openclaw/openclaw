/**
 * ShutdownController — Graduated force-close drain for gateway restart.
 *
 * Manages a multi-phase cascade when the gateway needs to restart but active
 * sessions / model calls are still in-flight:
 *
 *   Phase 1 (gracefulMs):  Wait for in-flight agent turns to complete normally.
 *   Phase 2 (softAbortMs): AbortController.abort() on all tracked model calls.
 *   Phase 3 (forceCloseMs): Destroy tracked WebSocket connections.
 *   Phase 4 (hardKillMs):   process.exit(0) if still hanging.
 *
 * All phase timestamps are cumulative from the restart trigger.
 */

export type ShutdownDrainPhase = "graceful" | "softAbort" | "forceClose" | "hardKill";

export type ShutdownDrainPhaseConfig = {
  /** Phase start threshold in ms (cumulative from restart trigger). */
  thresholdMs: number;
  /** Human-readable phase name. */
  phase: ShutdownDrainPhase;
};

export type ShutdownControllerConfig = {
  gracefulMs: number;
  softAbortMs: number;
  forceCloseMs: number;
  hardKillMs: number;
};

export const DEFAULT_SHUTDOWN_CONTROLLER_CONFIG: ShutdownControllerConfig = {
  gracefulMs: 10_000,
  softAbortMs: 20_000,
  forceCloseMs: 30_000,
  hardKillMs: 40_000,
};

export type ShutdownControllerState = {
  startedAt: number;
  currentPhase: ShutdownDrainPhase | null;
  phaseTransitions: Array<{ phase: ShutdownDrainPhase; atMs: number }>;
  abortedFetchCount: number;
  destroyedSocketCount: number;
  killed: boolean;
};

export type ShutdownControllerHooks = {
  onPhaseChange?: (phase: ShutdownDrainPhase, state: ShutdownControllerState) => void;
  onSoftAbort?: (state: ShutdownControllerState) => void;
  onForceClose?: (state: ShutdownControllerState) => void;
  onHardKill?: (state: ShutdownControllerState) => void;
};

/**
 * Resolve the active phase based on elapsed time and config thresholds.
 */
function resolveActivePhase(
  elapsedMs: number,
  phases: ShutdownDrainPhaseConfig[],
): ShutdownDrainPhase | null {
  // Phases are sorted ascending by threshold. Walk in reverse to find the
  // highest threshold we've exceeded.
  for (let i = phases.length - 1; i >= 0; i--) {
    if (elapsedMs >= phases[i].thresholdMs) {
      return phases[i].phase;
    }
  }
  return null;
}

/**
 * Build ordered phase configs from ShutdownControllerConfig.
 */
function buildPhaseTimeline(
  config: ShutdownControllerConfig,
): ShutdownDrainPhaseConfig[] {
  return [
    { thresholdMs: config.gracefulMs, phase: "graceful" },
    { thresholdMs: config.softAbortMs, phase: "softAbort" },
    { thresholdMs: config.forceCloseMs, phase: "forceClose" },
    { thresholdMs: config.hardKillMs, phase: "hardKill" },
  ].sort((a, b) => a.thresholdMs - b.thresholdMs);
}

/**
 * Tracks active AbortControllers for model calls that should be aborted
 * during the softAbort phase of a shutdown cascade.
 */
const activeModelFetchControllers = new Set<AbortController>();

export function trackActiveModelFetchController(controller: AbortController): void {
  activeModelFetchControllers.add(controller);
}

export function untrackActiveModelFetchController(controller: AbortController): void {
  activeModelFetchControllers.delete(controller);
}

function abortAllModelFetchControllers(): number {
  let count = 0;
  for (const controller of activeModelFetchControllers) {
    if (!controller.signal.aborted) {
      controller.abort();
      count++;
    }
  }
  activeModelFetchControllers.clear();
  return count;
}

/**
 * Tracks active WebSocket connections for force-close during shutdown.
 */
const activeSockets = new Set<{ close: (code?: number, reason?: string) => void }>();

export function trackActiveSocket(socket: {
  close: (code?: number, reason?: string) => void;
}): void {
  activeSockets.add(socket);
}

export function untrackActiveSocket(socket: {
  close: (code?: number, reason?: string) => void;
}): void {
  activeSockets.delete(socket);
}

function destroyAllSockets(): number {
  let count = 0;
  for (const socket of activeSockets) {
    try {
      socket.close(1001, "Gateway restart force-close");
      count++;
    } catch {
      // Best-effort close
    }
  }
  activeSockets.clear();
  return count;
}

/**
 * Create a new ShutdownController for a restart cascade.
 *
 * Call `tick()` periodically to advance phases based on elapsed time.
 * Returns the current state so callers can check whether hard-kill was triggered.
 */
export function createShutdownController(
  config: ShutdownControllerConfig,
  hooks?: ShutdownControllerHooks,
) {
  const phases = buildPhaseTimeline(config);
  const startedAt = Date.now();

  const state: ShutdownControllerState = {
    startedAt,
    currentPhase: null,
    phaseTransitions: [],
    abortedFetchCount: 0,
    destroyedSocketCount: 0,
    killed: false,
  };

  let lastPhase: ShutdownDrainPhase | null = null;

  return {
    getState: (): ShutdownControllerState => ({ ...state }),

    /**
     * Advance the phase cascade. Should be called on each drain poll interval.
     * Returns true if the process should continue waiting; false if hard-kill
     * was triggered (caller should stop polling).
     */
    tick: (): boolean => {
      const elapsedMs = Date.now() - startedAt;
      const activePhase = resolveActivePhase(elapsedMs, phases);

      if (activePhase !== lastPhase) {
        // Phase transition occurred
        lastPhase = activePhase;

        if (activePhase === "softAbort") {
          state.abortedFetchCount = abortAllModelFetchControllers();
          hooks?.onSoftAbort?.(state);
        } else if (activePhase === "forceClose") {
          state.destroyedSocketCount = destroyAllSockets();
          hooks?.onForceClose?.(state);
        } else if (activePhase === "hardKill") {
          state.killed = true;
          hooks?.onHardKill?.(state);
        }

        if (activePhase) {
          state.currentPhase = activePhase;
          state.phaseTransitions.push({ phase: activePhase, atMs: elapsedMs });
          hooks?.onPhaseChange?.(activePhase, state);
        }
      }

      if (state.killed) {
        return false;
      }

      return true;
    },

    /** Force an immediate hard kill (bypass phase cascade). */
    kill: (): void => {
      state.killed = true;
      state.currentPhase = "hardKill";
      state.phaseTransitions.push({ phase: "hardKill", atMs: Date.now() - startedAt });
      hooks?.onHardKill?.(state);
    },
  };
}
