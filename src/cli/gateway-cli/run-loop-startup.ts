import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { markGatewayRestartTrace } from "../../gateway/restart-trace.js";
import type { GatewayServerOptions, GatewayStartupOperation } from "../../gateway/server-public.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayOwnerSupervisor } from "../../infra/gateway-owner-lease.js";
import type { GatewayRestartEmitter } from "../../infra/restart.js";
import { SqliteIntegrityWorkerInterruptedError } from "../../infra/sqlite-integrity-worker-error.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { formatCliCommand } from "../command-format.js";

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
          `${onFailure && !retryFailed ? "Attempting automatic triage before recovery." : "Automatic recovery is unavailable."}${stack}`,
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
      work = {
        controller,
        settled: Promise.resolve().then(() => onFailure(error, controller.signal)),
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
          logger.info("Automatic triage did not complete a repair; awaiting manual recovery.");
          return false;
        }
        // Completion proves triage cleanup, not Gateway health. Startup owns that proof.
        logger.info("Automatic triage completed; retrying Gateway startup once.");
        return true;
      } catch (triageError) {
        if (controller.signal.aborted) {
          return false;
        }
        logger.error(`Automatic triage failed: ${formatErrorMessage(triageError)}`);
        if (supervisor) {
          throw triageError;
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
  stopCompletion?: Promise<void>;
  drain(): Promise<void>;
} {
  const scope = new AsyncWorkScope();
  let failure: { error: unknown } | undefined;
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
          failure ??= { error };
        }
        throw error;
      }
    });
  };
  return {
    run,
    close: () => scope.beginClose(),
    cancelledWith,
    failedWith: (error: unknown) => failure !== undefined && failure.error === error,
    async drain() {
      await scope.drain();
      // AsyncWorkScope joins descendants with allSettled; failed cleanup must
      // still make the accepted stop fail rather than certify a clean exit.
      if (failure) {
        throw failure.error;
      }
    },
  };
}

/** Join the retired generation and reset its admission before the next Gateway boot. */
export async function prepareGatewayRestartIteration(
  runtime: typeof import("./lifecycle.runtime.js"),
  logger: Pick<SubsystemLogger, "warn">,
): Promise<void> {
  // After an in-process restart (SIGUSR2), reset command-queue lane state.
  // Interrupted tasks from the previous lifecycle may have left `active`
  // counts elevated (their finally blocks never ran), permanently blocking
  // new work from draining. The same boundary also discards stale restart
  // deferral timers. Execution owners restore only their own durable work.
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
  // Rent: a failed startup has no server close handle, and restart hooks can
  // recreate shared slots after close. Reset the same lifecycle before boot.
  try {
    await drainGlobalSingletonLifecycleState("restart");
  } catch (error) {
    logger.warn(`failed to reset ambient runtime state: ${formatErrorMessage(error)}`);
  }
  markGatewayRestartTrace("restart.next-start");
}
