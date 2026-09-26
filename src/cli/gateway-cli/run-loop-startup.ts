import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { markGatewayRestartTrace } from "../../gateway/restart-trace.js";
import type { GatewayStartupOperation } from "../../gateway/server-public.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SqliteIntegrityWorkerInterruptedError } from "../../infra/sqlite-integrity-worker-error.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";

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
  onAdmissionReset: () => void,
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
  // resetAllLanes installs the next admission generation. Keep the local
  // mirror aligned so a restart queued during cleanup closes that generation.
  onAdmissionReset();
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
