import { MessageChannel } from "node:worker_threads";
import { racePromiseWithAbortSignal } from "../../../packages/retry/src/index.js";
import { measureGatewayCloseStep } from "../../gateway/restart-trace.js";
import {
  hasGatewayCleanupRetainedError,
  isGatewayCleanupRetainedError,
} from "../../gateway/server-shutdown.js";
import { finishDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../../process/supervisor/cancellation-policy.js";
import { shutdownProcessSupervisor } from "../../process/supervisor/index.js";
import { settlesWithin } from "../../shared/settle-within.js";
import { flushGatewayLogsBeforeExit } from "./run-loop-exit.js";
import type { GatewayShutdownFailure } from "./run-loop-terminal.js";
import type { ShutdownHardExitWatchdog } from "./shutdown-hard-exit.js";

/** Retains accepted cleanup, including native watchdog cancellation, until its real settlement. */
export function createGatewayRunCleanup(
  ownsProcessLifecycle: boolean | undefined,
  runtime: Pick<typeof import("./lifecycle.runtime.js"), "stopActiveManagedProviderLocalServices">,
  logger: Pick<SubsystemLogger, "warn" | "error">,
  isForegroundUpdateClosed: () => boolean,
  onRetained: () => void,
) {
  // Process-owned signal handling must survive gaps with no listening server.
  // Node's signal listeners and pending promises do not retain the event loop.
  const processLifetime = ownsProcessLifecycle ? new MessageChannel() : undefined;
  processLifetime?.port1.ref();
  // A settled rejection leaves custody, but must not lose the failed outcome.
  let cleanupFailed = false;
  let processResourcesDrained = false;
  let resourcesRetained = false;
  const retainResources = (name: string, detail: string) => {
    resourcesRetained = true;
    onRetained();
    logger.warn(`${name}: ${detail}; resources remain`);
  };
  const settleResource = async (name: string, run: () => void | Promise<void>, graceMs = 5_000) => {
    try {
      if (!(await settlesWithin(measureGatewayCloseStep(name, run), graceMs))) {
        retainResources(name, `cleanup exceeded ${graceMs}ms`);
        return false;
      }
      return true;
    } catch (error) {
      if (hasGatewayCleanupRetainedError(error)) {
        retainResources(name, formatErrorMessage(error));
      }
      if (!isGatewayCleanupRetainedError(error)) {
        throw error;
      }
      return false;
    }
  };
  const pendingCleanup = new Set<Promise<void>>();
  const retainCleanup = (completion: Promise<void>) => {
    pendingCleanup.add(completion);
    void completion.then(
      () => pendingCleanup.delete(completion),
      (error: unknown) => {
        pendingCleanup.delete(completion);
        if (hasGatewayCleanupRetainedError(error)) {
          retainResources("gateway lifecycle completion", formatErrorMessage(error));
        }
        if (isGatewayCleanupRetainedError(error)) {
          return;
        }
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
    await settleResource("restart.close.retained-cleanup", async () => {
      while (pendingCleanup.size > 0) {
        await Promise.allSettled(pendingCleanup);
      }
    });
  };
  const flushLogs = (graceMs = 3_000) =>
    settleResource(
      "restart.close.log-flush",
      () => flushGatewayLogsBeforeExit(logger, graceMs),
      graceMs,
    );
  const drainProcessResources = async () => {
    // Retained callbacks remain callable after an update replaces on-disk chunks.
    if (!isForegroundUpdateClosed()) {
      await settleResource("restart.close.provider-local-services", () =>
        runtime.stopActiveManagedProviderLocalServices(),
      ).catch((error: unknown) => {
        cleanupFailed = true;
        logger.warn(`managed local service shutdown failed: ${formatErrorMessage(error)}`);
      });
    }
    await settleResource("restart.close.snapshots", cleanupSnapshotOperations);
    await flushLogs();
    processResourcesDrained = true;
  };
  return {
    settleResource,
    classifyShutdownFailure(error: unknown, step: string): GatewayShutdownFailure | undefined {
      if (hasGatewayCleanupRetainedError(error)) {
        retainResources(step, formatErrorMessage(error));
      }
      if (isGatewayCleanupRetainedError(error)) {
        return undefined;
      }
      cleanupFailed = true;
      logger.error(
        `shutdown step failed (${step.replaceAll("-", " ")}): ${formatErrorMessage(error)}`,
      );
      return { step, error };
    },
    async stopStartupOperations(
      owner: { drain: () => Promise<void>; cancelledWith: (error: unknown) => boolean },
      work?: Promise<unknown>,
    ) {
      let failure: { error: unknown } | undefined;
      try {
        await settleResource("restart.close.startup-operations", () => owner.drain(), 5_000);
      } catch (error) {
        failure = { error };
      }
      // A successful late handle is published before the startup promise settles.
      try {
        await settleResource(
          "restart.close.startup",
          async () => {
            try {
              await work;
            } catch (error) {
              if (!owner.cancelledWith(error)) {
                throw error;
              }
            }
          },
          5_000,
        );
      } catch (error) {
        failure ??= { error };
      }
      return failure;
    },
    finish(code: number, errors: unknown[]) {
      // Final diagnostics follow the actual producer joins, including failed cleanup.
      finishDiagnosticsTimeline(
        ownsProcessLifecycle === true &&
          this.drained &&
          !resourcesRetained &&
          !cleanupFailed &&
          errors.length === 0 &&
          code === 0,
      );
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Gateway loop and final resource cleanup failed", {
          cause: errors[0],
        });
      }
      const exitCode = cleanupFailed && code === 0 ? 1 : code;
      if (ownsProcessLifecycle) {
        // Leaked handles remain the armed native watchdog's responsibility.
        process.exitCode = exitCode;
      }
      return exitCode;
    },
    async stopOwnedProcesses(): Promise<void> {
      if (!ownsProcessLifecycle) {
        return;
      }
      try {
        // Idle background commands outlive their agent loop, including retained runtimes.
        await settleResource(
          "process cleanup",
          shutdownProcessSupervisor,
          GRACEFUL_CANCEL_TIMEOUT_MS + 1_000,
        );
      } catch (error) {
        retainResources("process cleanup", formatErrorMessage(error));
      }
    },
    flushLogs,
    waitForPersistence: (completion: Promise<void> | undefined) =>
      settleResource("restart.close.persistence", () => completion, 3_000),
    async waitForStop(owner: { getStopCompletion: () => Promise<void> | undefined }) {
      const completion = owner.getStopCompletion();
      if (!completion) {
        return false;
      }
      await settleResource("restart.close.startup-stop", () => completion, 3_000);
      return true;
    },
    async waitForStartup<T>(completion: Promise<T>, signal: AbortSignal): Promise<T> {
      try {
        return await racePromiseWithAbortSignal(completion, signal, (aborted) => aborted.reason);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
        await settleResource(
          "restart.close.startup",
          async () => {
            await completion;
          },
          3_000,
        );
        throw error;
      }
    },
    async retireHost(host: { retire: () => Promise<void> } | undefined) {
      await settleResource("restart.close.host", () => host?.retire());
    },
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
          await settleResource(`restart.close.final.${name}`, operation, 3_000);
        } catch (error) {
          cleanupFailed = true;
          failures.push(error);
        }
      }
      // A failed owner stays retained; the outer CLI must not retry it with a global sweep.
      try {
        operations.onSettled?.(
          processResourcesDrained && !cleanupFailed && !resourcesRetained ? "drained" : "retained",
        );
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
