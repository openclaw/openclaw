import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import { maintainCronRunHistory } from "./store/run-history.js";

const log = createSubsystemLogger("cron/maintenance");
let scope: GatewaySchedulerScope | undefined;
let scheduledSweep: Promise<void> | undefined;

async function sweep(signal: AbortSignal) {
  let admitted = false;
  try {
    const preparation = getAgentDatabaseStartupAdmission()?.pendingPreparation;
    if (preparation) {
      log.info("Cron maintenance deferred until agent database startup preparation completes");
      await racePromiseWithAbortSignal(preparation, signal);
    }
    await runWithGatewayIndependentRootWorkAdmission(
      async () => {
        admitted = true;
        const context = captureOpenClawStateWorkerContext();
        const assertCurrent = context.admission.assertCurrent;
        await maintainCronRunHistory(context, assertCurrent);
        assertCurrent();
        const result = await runSessionRegistryMaintenance({ apply: true, assertCurrent });
        assertCurrent();
        if (result.skippedReason) {
          log.warn("Session registry maintenance skipped", { reason: result.skippedReason });
        }
      },
      "cron:maintenance",
      signal,
    );
  } catch (error) {
    // Cancellation before admission is expected; admitted failures still need reporting.
    if (admitted || (!signal.aborted && !isGatewayRestartDrainError(error))) {
      log.warn("Cron maintenance failed", { error });
    }
  }
}

/** Gateway lifecycle owns retention even when scheduled execution is disabled. */
export function startCronMaintenance(scheduler: GatewayScheduler) {
  if (scope && !scope.signal.aborted) {
    return;
  }
  scope = scheduler.scope();
  const { signal } = scope;
  scope.schedule({
    id: "cron-maintenance",
    delayMs: 5_000,
    everyMs: 60_000,
    run: () =>
      (scheduledSweep ??= sweep(signal).finally(() => {
        scheduledSweep = undefined;
      })),
  });
}

export async function stopCronMaintenance(): Promise<void> {
  await Promise.all([scope?.stop(), scheduledSweep]);
}
