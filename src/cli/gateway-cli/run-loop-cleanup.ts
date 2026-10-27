import { MessageChannel } from "node:worker_threads";
import { racePromiseWithAbortSignal } from "../../../packages/retry/src/index.js";
import { measureGatewayCloseStep } from "../../gateway/restart-trace.js";
import { finishDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import {
  hasGatewayCleanupRetainedError,
  isGatewayCleanupRetainedError,
} from "../../gateway/server-shutdown.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { shutdownProcessSupervisor } from "../../process/supervisor/index.js";
import { settlesWithin } from "../../shared/settle-within.js";
import { flushGatewayLogsBeforeExit } from "./run-loop-exit.js";
import type { GatewayShutdownFailure } from "./run-loop-terminal.js";
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

/** Retained handles require process exit even when final persistence reports a real failure. */
export async function finishGatewayRun(params: {
  code: number;
  failed: boolean;
  errors: unknown[];
  ownsProcessLifecycle?: boolean;
  resourcesRetained: boolean;
  logger: Pick<SubsystemLogger, "error">;
  flushLogs: () => Promise<boolean>;
}): Promise<number> {
  // A cleanup failure promotes success, preserving the supervisor's existing nonzero status.
  let code = (params.failed || params.errors.length > 0) && params.code === 0 ? 1 : params.code;
  if (params.resourcesRetained && params.ownsProcessLifecycle) {
    for (const error of params.errors) {
      params.logger.error(formatErrorMessage(error));
    }
    try {
      await params.flushLogs();
    } catch (error) {
      code ||= 1;
      params.logger.error(formatErrorMessage(error));
    }
    // Required writes/logs had their bounded grace. Keep the native watchdog
    // as a fallback for Node's rare V8 exit deadlock.
    return process.exit(code);
  }
  if (params.errors.length === 1) {
    throw params.errors[0];
  }
  if (params.errors.length > 1) {
    throw new AggregateError(params.errors, "Gateway loop and final resource cleanup failed", {
      cause: params.errors[0],
    });
  }
  return code;
}

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
    async stopStartupOperations(owner: { drain: () => Promise<void> }, work?: Promise<unknown>) {
      let failure: { error: unknown } | undefined;
      try {
        await settleResource("restart.close.startup-operations", () => owner.drain(), 5_000);
      } catch (error) {
        failure = { error };
      }
      // A successful late handle is published before the startup promise settles.
      await settleResource(
        "restart.close.startup",
        () =>
          work?.then(
            () => {},
            () => {},
          ),
        5_000,
      );
      return failure;
    },
    finish: (code: number, errors: unknown[]) =>
      finishGatewayRun({
        code,
        errors,
        failed: cleanupFailed,
        resourcesRetained,
        ownsProcessLifecycle,
        logger,
        flushLogs,
      }),
    async stopOwnedProcesses(): Promise<void> {
      if (!ownsProcessLifecycle) {
        return;
      }
      try {
        // Idle background commands outlive their agent loop, including retained runtimes.
        await settleResource("process cleanup", shutdownProcessSupervisor, 3_000);
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
