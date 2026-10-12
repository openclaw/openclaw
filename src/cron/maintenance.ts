import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import { maintainCronRunHistory } from "./store/run-history.js";

const log = createSubsystemLogger("cron/maintenance");
let scope: GatewaySchedulerScope | undefined;
let scheduledSweep: Promise<void> | undefined;
let nextHistorySweepAtMs = Infinity;
let nextRegistrySweepAtMs = Infinity;
let unsubscribeSessionChanges: (() => void) | undefined;

function scheduleSweep() {
  if (!scope || scope.signal.aborted || scheduledSweep) {
    return;
  }
  const { signal } = scope;
  scope.schedule({
    id: "cron-maintenance",
    atMs: Math.min(nextHistorySweepAtMs, nextRegistrySweepAtMs),
    run: () =>
      (scheduledSweep ??= sweep(signal).finally(() => {
        scheduledSweep = undefined;
        scheduleSweep();
      })),
  });
}

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
        const now = scope?.now() ?? Date.now();
        if (nextHistorySweepAtMs <= now) {
          nextHistorySweepAtMs = now + 60_000;
          await maintainCronRunHistory(context, assertCurrent);
          assertCurrent();
        }
        if (nextRegistrySweepAtMs <= now) {
          // Receipts arriving during the sweep can schedule another pass independently.
          nextRegistrySweepAtMs = Infinity;
          try {
            const result = await runSessionRegistryMaintenance({ apply: true, assertCurrent });
            assertCurrent();
            nextRegistrySweepAtMs = Math.min(
              nextRegistrySweepAtMs,
              result.nextSweepAtMs ?? Infinity,
            );
            if (result.skippedReason) {
              log.warn("Session registry maintenance skipped", { reason: result.skippedReason });
            }
          } catch (error) {
            nextRegistrySweepAtMs = Math.min(nextRegistrySweepAtMs, now + 60_000);
            throw error;
          }
        }
      },
      "cron:maintenance",
      signal,
    );
  } catch (error) {
    const now = scope?.now() ?? Date.now();
    if (nextHistorySweepAtMs <= now) {
      nextHistorySweepAtMs = now + 60_000;
    }
    if (nextRegistrySweepAtMs <= now) {
      nextRegistrySweepAtMs = now + 60_000;
    }
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
  nextHistorySweepAtMs = nextRegistrySweepAtMs = scope.now() + 5_000;
  unsubscribeSessionChanges = sessionChanges.subscribeFacts((change) => {
    const registryChanged =
      "all" in change
        ? change.scope === "config" || sessionChangeScopeAffectsStoredRows(change)
        : sessionChangeScopeAffectsStoredRows(change) && isCronRunSessionKey(change.sessionKey);
    if (!registryChanged) {
      return;
    }
    if (scope) {
      nextRegistrySweepAtMs = Math.min(nextRegistrySweepAtMs, scope.now() + 60_000);
    }
    scheduleSweep();
  });
  scheduleSweep();
}

export async function stopCronMaintenance(): Promise<void> {
  unsubscribeSessionChanges?.();
  unsubscribeSessionChanges = undefined;
  await Promise.all([scope?.stop(), scheduledSweep]);
}
