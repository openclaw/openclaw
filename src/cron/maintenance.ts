import { AsyncLocalStorage } from "node:async_hooks";
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
import { isAgentDatabaseDeletionSnapshotChangedError } from "../state/agent-deletion-journal.read.js";
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
let lastRegistrySuccessAtMs: number | null = null;
let unsubscribeSessionChanges: (() => void) | undefined;
let unsubscribeHistoryChanges: (() => void) | undefined;
let unsubscribeDatabaseLifecycle: (() => void) | undefined;

async function sweep(signal: AbortSignal, getCronStorePath: () => string) {
  let admitted = false;
  try {
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
              log.warn("Session registry maintenance skipped", {
                reason: result.skippedReason,
                retryAtMs: nextRegistrySweepAtMs,
                lastSuccessAtMs: lastRegistrySuccessAtMs,
              });
            } else {
              lastRegistrySuccessAtMs = scope?.now() ?? Date.now();
              log.info("Session registry maintenance completed", {
                lastSuccessAtMs: lastRegistrySuccessAtMs,
                nextSweepAtMs: Number.isFinite(nextRegistrySweepAtMs)
                  ? nextRegistrySweepAtMs
                  : null,
                pruned: result.pruned,
                skippedStores: result.skippedStores,
              });
            }
          } catch (error) {
            nextRegistrySweepAtMs = Math.min(
              nextRegistrySweepAtMs,
              (scope?.now() ?? Date.now()) + 60_000,
            );
            if (!isAgentDatabaseDeletionSnapshotChangedError(error)) {
              throw error;
            }
            log.warn("Session registry maintenance deferred", {
              reason: "agent-database-snapshot-changed",
              retryAtMs: nextRegistrySweepAtMs,
              lastSuccessAtMs: lastRegistrySuccessAtMs,
            });
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
  // Notifications can borrow startup admission; retention keeps the Gateway owner context.
  const scheduleSweep = AsyncLocalStorage.bind(() => {
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
          scheduleSweep();
        })),
    });
  });
  lastRegistrySuccessAtMs = null;
  nextHistorySweepAtMs = nextRegistrySweepAtMs = scope.now() + 5_000;
  const invalidateHistory = () => {
    if (scope) {
      nextHistorySweepAtMs = Math.min(nextHistorySweepAtMs, scope.now() + 60_000);
      scheduleSweep();
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
      const agentReady =
        "all" in change && typeof change.scope === "object" && change.scope.topology === true;
      nextRegistrySweepAtMs = Math.min(
        nextRegistrySweepAtMs,
        scope.now() + (agentReady ? 0 : 60_000),
      );
    }
    scheduleSweep();
  });
  scheduleSweep();
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
