import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { markGatewayRestartTrace } from "../../gateway/restart-trace.js";
import type { GatewayServerOptions, GatewayStartupOperation } from "../../gateway/server-public.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import type { GatewayOwnerSupervisor } from "../../infra/gateway-owner-lease.types.js";
import type { GatewayRestartEmitter } from "../../infra/restart.js";
import { SqliteIntegrityWorkerInterruptedError } from "../../infra/sqlite-integrity-worker-error.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { formatCliCommand } from "../command-format.js";
import { measureGatewayBootstrapStep } from "../startup-trace.js";
import { resolveGatewayShutdownBudget } from "./run-loop-shutdown-budget.js";

const lifecycleRuntimeLoader = createLazyImportLoader(() => import("./lifecycle.runtime.js"));

/** Prime lifecycle code and acquire initial custody before installing signal handlers. */
export async function prepareGatewayRunLoop(
  params: { lockPort?: number; lifecycleLockDeadlineMs?: number },
  logger: Pick<SubsystemLogger, "info" | "warn">,
) {
  // Updates rotate dist chunks; signal handling must retain this exact runtime.
  const lifecycleRuntime = await measureGatewayBootstrapStep(
    "cli.bootstrap.lifecycle-runtime",
    () => lifecycleRuntimeLoader.load(),
  );
  const supervisor = lifecycleRuntime.detectGatewayRespawnSupervisorIdentity(
    process.env,
    process.platform,
    { includeLinuxOpenClawGatewayServiceMarker: true },
  );
  const supervisorMode = supervisor?.kind ?? null;
  const restartDecision = lifecycleRuntime.resolveGatewayRestartDecision();
  // Resolve the native deadline before acquiring custody that needs final settlement.
  const startupBudget = await resolveGatewayShutdownBudget(supervisorMode, logger);
  const lock = await measureGatewayBootstrapStep("cli.bootstrap.gateway-lock", () =>
    acquireGatewayLock({
      port: params.lockPort,
      listenerMode: supervisorMode ? "supervised" : "foreground",
      supervisor,
      ...(params.lifecycleLockDeadlineMs !== undefined
        ? { lifecycleDeadlineMs: params.lifecycleLockDeadlineMs }
        : {}),
    }),
  );
  return { lifecycleRuntime, supervisor, supervisorMode, restartDecision, startupBudget, lock };
}

export type GatewayRunLoopStartOptions = Pick<
  GatewayServerOptions,
  | "processStartedAt"
  | "startupStartedAt"
  | "hostLifecycle"
  | "startupOperation"
  | "gatewayStateOwner"
> & { requestHotReloadRecovery?: GatewayRestartEmitter };

export type GatewayRestartStartupFailureHandler = (
  error: unknown,
  signal: AbortSignal,
) => Promise<"completed" | "failed" | void>;

export function createGatewayRestartRecovery(
  {
    onRestartStartupFailure: onFailure,
  }: {
    onRestartStartupFailure?: GatewayRestartStartupFailureHandler;
  },
  logger: Pick<SubsystemLogger, "info" | "error">,
  supervisor: GatewayOwnerSupervisor | null,
) {
  let work:
    | { controller: AbortController; settled: ReturnType<GatewayRestartStartupFailureHandler> }
    | undefined;
  return {
    reportStartupFailure(error: unknown, retryFailed: boolean) {
      const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
      logger.error(
        `gateway startup failed: ${formatErrorMessage(error)}. ` +
          `${onFailure && !retryFailed ? "Attempting automatic startup recovery." : "Automatic recovery is unavailable."}${stack}`,
      );
    },
    reportManualRecovery() {
      const resume =
        supervisor?.kind === "external"
          ? "use your external supervisor to restart the Gateway"
          : process.platform === "win32"
            ? supervisor
              ? `restart with: ${formatCliCommand("openclaw gateway restart")}`
              : "press Ctrl+C, then rerun your original Gateway command"
            : `reload with: kill -USR2 ${process.pid}`;
      logger.error(
        `Process will stay alive for manual recovery. Fix the startup refusal above, run ${formatCliCommand("openclaw doctor --fix")}, then ${resume}`,
      );
    },
    abort() {
      work?.controller.abort();
    },
    async waitForCleanup() {
      await work?.settled;
    },
    async attempt(error: unknown): Promise<boolean> {
      if (!onFailure) {
        return false;
      }
      const controller = new AbortController();
      const settled = Promise.resolve()
        .then(() => onFailure(error, controller.signal))
        .catch((recoveryError: unknown) => {
          if (controller.signal.aborted && isAbortError(recoveryError)) {
            return undefined;
          }
          throw recoveryError;
        });
      work = {
        controller,
        settled,
      };
      try {
        const completion = await work.settled;
        if (controller.signal.aborted) {
          return false;
        }
        if (completion === "failed") {
          throw error;
        }
        if (completion !== "completed") {
          logger.info("Automatic startup recovery did not complete; awaiting manual recovery.");
          return false;
        }
        // Recovery completion only admits one retry; startup owns the health proof.
        logger.info("Automatic startup recovery completed; retrying Gateway startup once.");
        return true;
      } catch (recoveryError) {
        logger.error(`Automatic startup recovery failed: ${formatErrorMessage(recoveryError)}`);
        if (supervisor) {
          throw recoveryError;
        }
        return false;
      } finally {
        work = undefined;
      }
    },
  };
}

export function createGatewayStartupOperations(): {
  run: GatewayStartupOperation;
  close(): void;
  cancelledWith(error: unknown): boolean;
  failedWith(error: unknown): boolean;
  acknowledgeHandledFailure(error: unknown): void;
  getStopCompletion(): Promise<void> | undefined;
  retainStopCompletion(completion: Promise<void>): void;
  drain(): Promise<void>;
} {
  const scope = new AsyncWorkScope();
  let stopCompletion: Promise<void> | undefined;
  const failures = new Set<unknown>();
  // A process-group stop can kill a child before its separate admission owner is cancelled.
  const cancelledWith = (error: unknown) =>
    scope.signal.aborted &&
    (error === scope.signal.reason ||
      (error instanceof SqliteIntegrityWorkerInterruptedError &&
        (error.signal === "SIGTERM" || error.signal === "SIGINT")));
  const run: GatewayStartupOperation = async (operation) => {
    if (scope.isClosing) {
      throw scope.signal.reason;
    }
    return await scope.track(async () => {
      try {
        return await operation(scope.signal);
      } catch (error) {
        if (!cancelledWith(error)) {
          failures.add(error);
        }
        throw error;
      }
    });
  };
  return {
    run,
    getStopCompletion: () => stopCompletion,
    retainStopCompletion: (completion) => {
      stopCompletion = completion;
    },
    close: () => scope.beginClose(),
    cancelledWith,
    failedWith: (error: unknown) => failures.has(error),
    acknowledgeHandledFailure: (error: unknown) => {
      failures.delete(error);
    },
    async drain() {
      await scope.drain();
      // AsyncWorkScope joins descendants with allSettled; failed cleanup must
      // still make the accepted stop fail rather than certify a clean exit.
      if (failures.size > 0) {
        throw failures.values().next().value;
      }
    },
  };
}

/** Join the retired generation and reset its admission before the next Gateway boot. */
export async function prepareGatewayRestartIteration(
  runtime: typeof import("./lifecycle.runtime.js"),
  logger: Pick<SubsystemLogger, "warn">,
  isCurrent: () => boolean,
): Promise<void> {
  // Retire stale activity counts and timers; execution owners restore durable work.
  const {
    abortActiveCronTaskRuns,
    advanceCronActiveJobGeneration,
    retireActiveCronTaskRunTracking,
    resetCronActiveJobs,
    resetAllLanes,
    resetGatewayRestartStateForInProcessRestart,
    resetGatewaySuspendCoordinatorForLifecycleRestart,
    rotateAgentEventLifecycleGeneration,
    waitForActiveCronJobs,
    waitForActiveCronTaskRuns,
  } = runtime;
  // Rotation aborts rootless stale owners before reset pumps preserved queues.
  rotateAgentEventLifecycleGeneration();
  advanceCronActiveJobGeneration();
  abortActiveCronTaskRuns("Gateway restarting.");
  const cronTaskDrain = await waitForActiveCronTaskRuns(1_000);
  const cronDrain = await waitForActiveCronJobs(1_000);
  // A terminal decision made during these joins must not reopen root admission.
  if (!isCurrent()) {
    return;
  }
  if (!cronTaskDrain.drained || !cronDrain.drained) {
    logger.warn(
      `cron run drain timed out during restart lifecycle reset after retiring old cron admission; ${cronTaskDrain.active} task handle(s) and ${cronDrain.active} active marker(s) remain after aborting old cron runs`,
    );
  }
  retireActiveCronTaskRunTracking();
  resetCronActiveJobs();
  // Resume the retired scheduler before resetAllLanes invalidates its
  // suspension admission callback and discards the coordinator entry.
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetAllLanes();
  clearRuntimeConfigSnapshot();
  resetGatewayRestartStateForInProcessRestart();
  // Failed startup has no close handle; restart hooks can also recreate shared slots.
  try {
    await drainGlobalSingletonLifecycleState("restart");
  } catch (error) {
    logger.warn(`failed to reset ambient runtime state: ${formatErrorMessage(error)}`);
  }
  if (isCurrent()) {
    markGatewayRestartTrace("restart.next-start");
  }
}
