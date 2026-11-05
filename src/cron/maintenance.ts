import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
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
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import { subscribeCronRunHistoryChanges } from "./store/run-history-changes.js";
import { maintainCronRunHistory } from "./store/run-history.js";

const log = createSubsystemLogger("cron/maintenance");
let scope: GatewaySchedulerScope | undefined;
let scheduledSweep: Promise<void> | undefined;
let nextHistorySweepAtMs = Infinity;
let nextRegistrySweepAtMs = Infinity;
let unsubscribeSessionChanges: (() => void) | undefined;
let unsubscribeHistoryChanges: (() => void) | undefined;
let unsubscribeDatabaseLifecycle: (() => void) | undefined;

function scheduleSweep(getCronStorePath: () => string) {
  if (!scope || scope.signal.aborted || scheduledSweep) {
    return;
  }
  const atMs = Math.min(nextHistorySweepAtMs, nextRegistrySweepAtMs);
  if (!Number.isFinite(atMs)) {
    return;
  }
  const { signal } = scope;
  scope.schedule({
    id: "cron-maintenance",
    atMs,
    run: () =>
      (scheduledSweep ??= sweep(signal, getCronStorePath).finally(() => {
        scheduledSweep = undefined;
        scheduleSweep(getCronStorePath);
      })),
  });
}

async function sweep(signal: AbortSignal, getCronStorePath: () => string) {
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
          nextHistorySweepAtMs = Infinity;
          try {
            const result = await maintainCronRunHistory(context, assertCurrent);
            assertCurrent();
            nextHistorySweepAtMs = Math.min(nextHistorySweepAtMs, result.nextSweepAtMs ?? Infinity);
          } catch (error) {
            nextHistorySweepAtMs = Math.min(nextHistorySweepAtMs, now + 60_000);
            throw error;
          }
        }
        if (nextRegistrySweepAtMs <= now) {
          // Receipts arriving during the sweep can schedule another pass independently.
          nextRegistrySweepAtMs = Infinity;
          try {
            const result = await runSessionRegistryMaintenance({
              apply: true,
              assertCurrent,
              cronStorePath: getCronStorePath(),
            });
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
export function startCronMaintenance(scheduler: GatewayScheduler, getCronStorePath: () => string) {
  if (scope && !scope.signal.aborted) {
    return;
  }
  scope = scheduler.scope();
  nextHistorySweepAtMs = nextRegistrySweepAtMs = scope.now() + 5_000;
  const invalidateHistory = () => {
    if (scope) {
      nextHistorySweepAtMs = Math.min(nextHistorySweepAtMs, scope.now() + 60_000);
      scheduleSweep(getCronStorePath);
    }
  };
  unsubscribeHistoryChanges = subscribeCronRunHistoryChanges((databasePath) => {
    if (normalizeDatabasePath(databasePath) === resolveOpenClawStateSqlitePath()) {
      invalidateHistory();
    }
  });
  unsubscribeDatabaseLifecycle = registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened") {
      invalidateHistory();
    }
  });
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
    scheduleSweep(getCronStorePath);
  });
  scheduleSweep(getCronStorePath);
}

export async function stopCronMaintenance(): Promise<void> {
  unsubscribeSessionChanges?.();
  unsubscribeSessionChanges = undefined;
  unsubscribeHistoryChanges?.();
  unsubscribeHistoryChanges = undefined;
  unsubscribeDatabaseLifecycle?.();
  unsubscribeDatabaseLifecycle = undefined;
  await Promise.all([scope?.stop(), scheduledSweep]);
}
