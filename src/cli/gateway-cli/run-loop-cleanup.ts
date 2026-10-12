import { MessageChannel } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { flushGatewayLogsBeforeExit } from "./run-loop-exit.js";
import type { ShutdownHardExitWatchdog } from "./shutdown-hard-exit.js";

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
      retainCleanup(watchdog.cancel());
    }
  };
  const joinCleanup = async () => {
    while (pendingCleanup.size > 0) {
      await Promise.allSettled(pendingCleanup);
    }
  };
  const drainProcessResources = async () => {
    // Retained callbacks remain callable after an update replaces on-disk chunks.
    if (!isForegroundUpdateClosed()) {
      await runtime.stopActiveManagedProviderLocalServices().catch((error: unknown) => {
        cleanupFailed = true;
        logger.warn(`managed local service shutdown failed: ${formatErrorMessage(error)}`);
      });
    }
    await cleanupSnapshotOperations();
    await flushGatewayLogsBeforeExit(logger);
    processResourcesDrained = true;
  };
  return {
    retain: retainCleanup,
    retireWatchdog,
    waitForCleanup: joinCleanup,
    async settleFinalResources(operations: {
      retireSignals: () => void;
      drainSignals: () => Promise<void>;
      releaseRestartRuntime: () => Promise<void> | undefined;
      closeTerminalServer: () => Promise<void>;
      retireHost: () => Promise<void> | undefined;
      releaseLock: () => Promise<void>;
      clearStartupWatchdog: () => void;
      clearRequestWatchdogs: () => void;
      cleanupSignals: () => void;
      onSettled?: (outcome: "drained" | "retained") => void;
    }): Promise<unknown[]> {
      const failures: unknown[] = [];
      // Every admitted owner gets its ordered retirement even if an earlier one rejects.
      const finalizers: Array<() => void | Promise<void>> = [
        operations.retireSignals,
        operations.drainSignals,
        joinCleanup,
        operations.releaseRestartRuntime,
        operations.closeTerminalServer,
        operations.retireHost,
        operations.releaseLock,
        operations.clearStartupWatchdog,
        operations.clearRequestWatchdogs,
        joinCleanup,
        operations.cleanupSignals,
      ];
      for (const operation of finalizers) {
        try {
          await operation();
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
