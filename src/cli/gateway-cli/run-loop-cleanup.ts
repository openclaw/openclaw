import { MessageChannel } from "node:worker_threads";
import { measureGatewayCloseStep } from "../../gateway/restart-trace.js";
import { finishDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { flushGatewayLogsBeforeExit } from "./run-loop-exit.js";
import type { ShutdownHardExitWatchdog } from "./shutdown-hard-exit.js";

/** Called only after settleFinalResources has joined every admitted cleanup owner. */
export function finishGatewayRunCleanup(params: {
  cleanup: Pick<ReturnType<typeof createGatewayRunCleanup>, "drained" | "failed">;
  failures: unknown[];
  loopFailure?: { error: unknown };
  hostExitRequested: boolean;
  hostExitCode: number;
  terminalExitCode: number | undefined;
  ownsProcessLifecycle: boolean | undefined;
}): number {
  const { cleanup, failures, loopFailure, hostExitRequested, hostExitCode, terminalExitCode } =
    params;
  if (loopFailure) {
    failures.unshift(loopFailure.error);
  }
  const code = hostExitRequested && terminalExitCode === 0 ? hostExitCode : (terminalExitCode ?? 0);
  // Foreground completion and process exit are not producer barriers. This follows
  // canonical close, detached work, and retained cleanup, including failed joins.
  finishDiagnosticsTimeline(
    params.ownsProcessLifecycle === true &&
      cleanup.drained &&
      !cleanup.failed &&
      failures.length === 0 &&
      code === 0,
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Gateway loop and final resource cleanup failed", {
      cause: failures[0],
    });
  }
  // Cleanup failure promotes success, but cannot replace a supervisor-owned
  // failure status that already selects its terminal recovery behavior.
  return cleanup.failed && code === 0 ? 1 : code;
}

/** Retains accepted cleanup, including native watchdog cancellation, until its real settlement. */
export function createGatewayRunCleanup(
  ownsProcessLifecycle: boolean | undefined,
  runtime: Pick<typeof import("./lifecycle.runtime.js"), "stopActiveManagedProviderLocalServices">,
  logger: Pick<SubsystemLogger, "warn" | "error">,
  isForegroundUpdateClosed: () => boolean,
) {
  // Process-owned signal handling must survive gaps with no listening server.
  // Node's signal listeners and pending promises do not retain the event loop.
  const processLifetime = ownsProcessLifecycle ? new MessageChannel() : undefined;
  processLifetime?.port1.ref();
  // A settled rejection leaves custody, but must not lose the failed outcome.
  let cleanupFailed = false;
  let processResourcesDrained = false;
  const pendingCleanup = new Set<Promise<void>>();
  const retainCleanup = (completion: Promise<void>) => {
    pendingCleanup.add(completion);
    void completion.then(
      () => pendingCleanup.delete(completion),
      (error: unknown) => {
        pendingCleanup.delete(completion);
        cleanupFailed = true;
        logger.error(`gateway lifecycle completion failed: ${formatErrorMessage(error)}`);
      },
    );
  };
  const retireWatchdog = (watchdog: ShutdownHardExitWatchdog | null) => {
    if (watchdog) {
      retainCleanup(measureGatewayCloseStep("restart.close.watchdog", () => watchdog.cancel()));
    }
  };
  const joinCleanup = async () => {
    await measureGatewayCloseStep("restart.close.retained-cleanup", async () => {
      while (pendingCleanup.size > 0) {
        await Promise.allSettled(pendingCleanup);
      }
    });
  };
  const drainProcessResources = async () => {
    // Retained callbacks remain callable after an update replaces on-disk chunks.
    if (!isForegroundUpdateClosed()) {
      await measureGatewayCloseStep("restart.close.provider-local-services", () =>
        runtime.stopActiveManagedProviderLocalServices(),
      ).catch((error: unknown) => {
        cleanupFailed = true;
        logger.warn(`managed local service shutdown failed: ${formatErrorMessage(error)}`);
      });
    }
    await measureGatewayCloseStep("restart.close.snapshots", cleanupSnapshotOperations);
    await measureGatewayCloseStep("restart.close.log-flush", () =>
      flushGatewayLogsBeforeExit(logger),
    );
    processResourcesDrained = true;
  };
  return {
    retain: retainCleanup,
    retireWatchdog,
    waitForCleanup: joinCleanup,
    async settleFinalResources(operations: {
      retireSignals: () => void;
      drainSignals: () => Promise<void>;
      closeTerminalServer: () => Promise<void>;
      retireHost: () => Promise<void> | undefined;
      closeSharedState: () => Promise<void>;
      releaseLock: () => Promise<void>;
      clearStartupWatchdog: () => void;
      clearRequestWatchdogs: () => void;
      cleanupSignals: () => void;
      onSettled?: (outcome: "drained" | "retained") => void;
    }): Promise<unknown[]> {
      const failures: unknown[] = [];
      // Every admitted owner gets its ordered retirement even if an earlier one rejects.
      const finalizers: Array<[string, () => void | Promise<void>]> = [
        ["retire-signals", operations.retireSignals],
        ["drain-signals", operations.drainSignals],
        ["retained-cleanup", joinCleanup],
        ["terminal-server", operations.closeTerminalServer],
        ["host", operations.retireHost],
        ["retained-cleanup", joinCleanup],
        ["shared-state", operations.closeSharedState],
        ["release-lock", operations.releaseLock],
        ["startup-watchdog", operations.clearStartupWatchdog],
        [
          "request-watchdogs",
          () => {
            // Retained native handles still need the owned process's hard-exit safety net.
            if (!ownsProcessLifecycle || !cleanupFailed) {
              operations.clearRequestWatchdogs();
            }
          },
        ],
        ["retained-cleanup", joinCleanup],
        ["cleanup-signals", operations.cleanupSignals],
      ];
      for (const [name, operation] of finalizers) {
        try {
          await measureGatewayCloseStep(`restart.close.final.${name}`, operation);
        } catch (error) {
          cleanupFailed = true;
          failures.push(error);
        }
      }
      // A failed owner stays retained; the outer CLI must not retry it with a global sweep.
      try {
        operations.onSettled?.(processResourcesDrained && !cleanupFailed ? "drained" : "retained");
      } catch (error) {
        cleanupFailed = true;
        failures.push(error);
      }
      return failures;
    },
    drainProcessResources,
    get failed() {
      return cleanupFailed;
    },
    get drained() {
      return processResourcesDrained;
    },
    markFailed() {
      cleanupFailed = true;
    },
    beginIteration() {
      processResourcesDrained = false;
    },
    releaseProcessLifetime() {
      processLifetime?.port1.close();
      processLifetime?.port2.close();
    },
  };
}
