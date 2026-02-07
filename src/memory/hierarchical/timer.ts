/**
 * Timer for running the hierarchical memory worker periodically.
 *
 * All state is instance-scoped in the returned handle, so multiple
 * timers (e.g., different agentIds or tests) don't collide.
 */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveHierarchicalMemoryConfig } from "./config.js";
import { runHierarchicalMemoryWorker } from "./worker.js";

export type HierarchicalMemoryTimerHandle = {
  /** Stop the timer */
  stop: () => void;
  /** Get the last run result */
  getLastResult: () => WorkerRunInfo | null;
};

type WorkerRunInfo = {
  timestamp: number;
  success: boolean;
  chunksProcessed?: number;
  mergesPerformed?: number;
  error?: string;
  durationMs?: number;
};

/**
 * Start the hierarchical memory worker timer.
 * Returns a handle to stop the timer.
 */
export function startHierarchicalMemoryTimer(params: {
  agentId: string;
  config: OpenClawConfig;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}): HierarchicalMemoryTimerHandle | null {
  const memoryConfig = resolveHierarchicalMemoryConfig(params.config);

  if (!memoryConfig.enabled) {
    return null;
  }

  const log = params.log ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  // Instance-scoped state
  let handle: ReturnType<typeof setInterval> | null = null;
  let lastResult: WorkerRunInfo | null = null;
  let isRunning = false;

  const runWorker = async () => {
    if (isRunning) {
      return; // Skip if previous run is still in progress
    }

    isRunning = true;
    try {
      const result = await runHierarchicalMemoryWorker({
        agentId: params.agentId,
        config: params.config,
      });

      lastResult = {
        timestamp: Date.now(),
        success: result.success,
        chunksProcessed: result.chunksProcessed,
        mergesPerformed: result.mergesPerformed,
        error: result.error,
        durationMs: result.durationMs,
      };

      if (result.skipped) {
        // Silent skip - lock held or disabled
        return;
      }

      if (result.success) {
        if ((result.chunksProcessed ?? 0) > 0 || (result.mergesPerformed ?? 0) > 0) {
          log.info(
            `hierarchical memory: processed ${result.chunksProcessed ?? 0} chunks, ` +
              `${result.mergesPerformed ?? 0} merges (${result.durationMs}ms)`,
          );
        }
      } else if (result.error) {
        log.error(`hierarchical memory worker failed: ${result.error}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      lastResult = {
        timestamp: Date.now(),
        success: false,
        error,
      };
      log.error(`hierarchical memory worker error: ${error}`);
    } finally {
      isRunning = false;
    }
  };

  // Run immediately on start
  void runWorker();

  // Then run on interval
  handle = setInterval(() => {
    void runWorker();
  }, memoryConfig.workerIntervalMs);

  log.info(
    `hierarchical memory timer started (interval: ${Math.round(memoryConfig.workerIntervalMs / 1000)}s)`,
  );

  const timerHandle: HierarchicalMemoryTimerHandle = {
    stop: () => {
      if (handle) {
        clearInterval(handle);
        handle = null;
      }
    },
    getLastResult: () => lastResult,
  };

  return timerHandle;
}
