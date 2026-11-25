import { AsyncLocalStorage } from "node:async_hooks";
import {
  nextPromptCacheKeepWarmDueAtMs,
  notePromptCacheKeepWarmChange,
  promptCacheKeepWarmState,
} from "../agents/prompt-cache-keep-warm-candidates.js";
import { getRuntimeConfig } from "../config/config.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { isConstrainedProcessLowOnMemory } from "../infra/host-memory.js";
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
let nextPromptCacheSweepAtMs = Infinity;
let promptCacheKeepWarmPass: Promise<void> | undefined;
let scheduleMaintenance: (() => void) | undefined;
let lastRegistrySuccessAtMs: number | null = null;
let unsubscribeSessionChanges: (() => void) | undefined;
let unsubscribeHistoryChanges: (() => void) | undefined;
let unsubscribeDatabaseLifecycle: (() => void) | undefined;

/**
 * Keep-warm pings run beside retention, never inside its single-flight sweep: one pass at a
 * time, which reports its own next wake.
 */
function startPromptCacheKeepWarm(signal: AbortSignal) {
  const now = scope?.now() ?? Date.now();
  if (promptCacheKeepWarmPass || nextPromptCacheSweepAtMs > now) {
    return;
  }
  nextPromptCacheSweepAtMs = Infinity;
  // Admit before importing the agent runtime. The pass rechecks after the asynchronous
  // import because config and available memory can change while it is loading.
  if (getRuntimeConfig().agents?.defaults?.promptCacheKeepWarm === false) {
    promptCacheKeepWarmState.candidates.clear();
    return;
  }
  if (isConstrainedProcessLowOnMemory()) {
    nextPromptCacheSweepAtMs = now + 60_000;
    return;
  }
  promptCacheKeepWarmPass = import("../agents/prompt-cache-keep-warm.js")
    .then(({ runPromptCacheKeepWarm }) => runPromptCacheKeepWarm(signal))
    .then(
      (next) => {
        nextPromptCacheSweepAtMs = Math.min(nextPromptCacheSweepAtMs, next);
      },
      (error: unknown) => {
        nextPromptCacheSweepAtMs = Math.min(
          nextPromptCacheSweepAtMs,
          nextPromptCacheKeepWarmDueAtMs(),
          (scope?.now() ?? Date.now()) + 60_000,
        );
        if (!signal.aborted) {
          log.warn("Prompt cache keep-warm pass failed", { error });
        }
      },
    )
    .finally(() => {
      promptCacheKeepWarmPass = undefined;
      scheduleMaintenance?.();
    });
}

async function sweep(signal: AbortSignal, getCronStorePath: () => string) {
  startPromptCacheKeepWarm(signal);
  if (isConstrainedProcessLowOnMemory()) {
    // Retention is best effort; leave scarce memory to requests before opening its workers.
    const now = scope?.now() ?? Date.now();
    if (nextHistorySweepAtMs <= now) {
      nextHistorySweepAtMs = now + 60_000;
    }
    if (nextRegistrySweepAtMs <= now) {
      nextRegistrySweepAtMs = now + 60_000;
    }
    return;
  }
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
    // The in-flight pass rearms its own wake; due receipts must not spin the scheduler
    // while the lazy import or a ping is still settling.
    const atMs = Math.min(
      nextHistorySweepAtMs,
      nextRegistrySweepAtMs,
      promptCacheKeepWarmPass ? Infinity : nextPromptCacheSweepAtMs,
    );
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
  scheduleMaintenance = scheduleSweep;
  lastRegistrySuccessAtMs = null;
  // The first keep-warm pass recovers sessions whose cache a restart left warm.
  nextHistorySweepAtMs = nextRegistrySweepAtMs = nextPromptCacheSweepAtMs = scope.now() + 5_000;
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
    // An opt-out parks keep-warm at Infinity; enabling after a disabled startup must
    // rearm the initial recovery without waiting for another transcript change.
    if ("all" in change && change.scope === "config" && scope) {
      nextPromptCacheSweepAtMs = Math.min(nextPromptCacheSweepAtMs, scope.now() + 5_000);
    }
    const keepWarmDueAtMs = scope ? notePromptCacheKeepWarmChange(change, scope.now()) : undefined;
    if (keepWarmDueAtMs !== undefined && keepWarmDueAtMs < nextPromptCacheSweepAtMs) {
      nextPromptCacheSweepAtMs = keepWarmDueAtMs;
      scheduleSweep();
    }
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
  scheduleMaintenance = undefined;
  await Promise.all([scope?.stop(), scheduledSweep, promptCacheKeepWarmPass]);
}
