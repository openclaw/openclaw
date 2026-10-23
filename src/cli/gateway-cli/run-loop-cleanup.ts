import { MessageChannel } from "node:worker_threads";
import { measureGatewayCloseStep } from "../../gateway/restart-trace.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { flushGatewayLogsBeforeExit } from "./run-loop-exit.js";
import type { GatewayShutdownFailure } from "./run-loop-terminal.js";
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
        ["request-watchdogs", operations.clearRequestWatchdogs],
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

/**
 * Decide how a restart generation finishes after the server closed.
 *
 * A failed close leaves this process unable to resume in-process, and a
 * schtasks-supervised run that exits nonzero is never relaunched (manual task
 * starts ignore RestartOnFailure). The handoff observer waits for this PID to
 * exit before /Run, so the replacement re-admits state fresh.
 */
export async function finishRestartActionAfterClose(params: {
  shutdownFailure?: GatewayShutdownFailure;
  handoffClosed: boolean;
  managedUpdateOwner?: GatewayRestartIntent["successorOwner"];
  resumeInProcess: boolean;
  hasInstallationReplacement: boolean;
  supervisorMode: "external" | "launchd" | "schtasks" | "systemd" | null;
  getManagedUpdateOwner: () => unknown;
  writeStabilityBundle: (name: string, error: unknown, step?: string) => void;
  handleRestartAfterServerClose: (
    owner?: GatewayRestartIntent["successorOwner"],
    initiallyCancelled?: boolean,
    failure?: GatewayShutdownFailure,
  ) => Promise<void>;
  forceExitAfterStabilityBundle: (
    reason: string,
    exitCode?: number,
    failure?: GatewayShutdownFailure,
  ) => Promise<void>;
}): Promise<void> {
  const { shutdownFailure } = params;
  if (!shutdownFailure) {
    if (params.handoffClosed) {
      await params.handleRestartAfterServerClose(params.managedUpdateOwner, params.resumeInProcess);
    }
    return;
  }
  if (
    (params.hasInstallationReplacement || params.supervisorMode === "schtasks") &&
    !params.getManagedUpdateOwner()
  ) {
    params.writeStabilityBundle(
      "gateway.restart_close_failed",
      shutdownFailure.error,
      shutdownFailure.step,
    );
    await params.handleRestartAfterServerClose(undefined, false, shutdownFailure);
  } else {
    // forceExitAfterStabilityBundle records the bundle itself; do not double-write.
    await params.forceExitAfterStabilityBundle("gateway.restart_close_failed", 1, shutdownFailure);
  }
}
