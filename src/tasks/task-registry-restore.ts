import { formatErrorMessage } from "../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  classifyGatewayStorageFailure,
  type GatewayStorageFailure,
} from "../infra/sqlite-error-diagnostics.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

type RestoreState =
  | { status: "uninitialized" | "restoring" | "ready" }
  | { status: "failed"; error: Error; retryAtMs?: number };

type SnapshotStore<Snapshot> = {
  withSnapshotAsync<T>(
    context: OpenClawStateWorkerContext,
    consume: (snapshot: Snapshot, reconcile?: () => Promise<void>) => T,
  ): Promise<T>;
};

// Storage failures that describe the moment, not the file. Corruption and schema errors stay latched.
const TRANSIENT_RESTORE_FAILURES = new Set<GatewayStorageFailure>([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_IOERR",
  "SQLITE_FULL",
]);
const TRANSIENT_RESTORE_RETRY_MS = 30_000;

function isTransientRestoreFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth += 1) {
    const failure = classifyGatewayStorageFailure(current);
    if (failure && TRANSIENT_RESTORE_FAILURES.has(failure)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** A transient failure may be restored again after this time; others stay sticky until reload. */
export function resolveRegistryRestoreRetryAtMs(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  return isTransientRestoreFailure(error) ? nowMs + TRANSIENT_RESTORE_RETRY_MS : undefined;
}

/** Restore entry points may start a retry once this is due; the failure stays recorded meanwhile. */
export function isRegistryRestoreRetryDue(
  state: { retryAtMs?: number },
  nowMs = Date.now(),
): boolean {
  return state.retryAtMs !== undefined && nowMs >= state.retryAtMs;
}

/** One synchronous restore may reread once; settlement and publication stay with its owner. */
export function createSyncRegistryReader<Snapshot>(owner: {
  admission: OpenClawStateDatabaseReadAdmission;
  captureAdmission: () => OpenClawStateDatabaseReadAdmission;
  isCurrent: () => boolean;
  isCurrentDatabase: (admission: OpenClawStateDatabaseReadAdmission) => boolean;
  loadSnapshot: () => Snapshot;
  changedMessage: string;
}) {
  let admission = owner.admission;
  let invalidated = false;
  let retried = false;
  const assertCurrent = () => {
    try {
      admission.assertCurrent();
      if (!owner.isCurrent() || !owner.isCurrentDatabase(admission)) {
        throw new Error(owner.changedMessage);
      }
    } catch (error) {
      invalidated = true;
      throw error;
    }
  };
  return {
    get admission() {
      return admission;
    },
    get invalidated() {
      return invalidated;
    },
    assertCurrent,
    loadSnapshot(this: void) {
      if (!owner.isCurrent()) {
        assertCurrent();
      }
      const snapshot = owner.loadSnapshot();
      try {
        assertCurrent();
        return snapshot;
      } catch (error) {
        if (retried || !owner.isCurrent()) {
          throw error;
        }
        retried = true;
        admission = owner.captureAdmission();
        assertCurrent();
        invalidated = false;
        const current = owner.loadSnapshot();
        assertCurrent();
        return current;
      }
    },
  };
}

/** Coalesce preparation; each registry retains its authoritative state and publication. */
export function createAsyncRegistryRestore<Snapshot, Store extends SnapshotStore<Snapshot>>(owner: {
  isCurrentDatabase: (admission: OpenClawStateDatabaseReadAdmission) => boolean;
  getState: (admission: OpenClawStateDatabaseReadAdmission) => RestoreState;
  getRevision: () => number;
  getStore: () => Store;
  received?: (snapshot: Snapshot, context: OpenClawStateWorkerContext, store: Store) => void;
  reconcile?: (
    snapshot: Snapshot,
    context: OpenClawStateWorkerContext,
    store: Store,
    reconcile: () => Promise<void>,
  ) => Promise<void>;
  install: (
    snapshot: Snapshot,
    context: OpenClawStateWorkerContext,
  ) => (reconcile: () => Promise<void>) => void | Promise<void>;
  fail: (error: unknown, admission: OpenClawStateDatabaseReadAdmission) => never;
  onReady?: () => void;
}): (context: OpenClawStateWorkerContext) => Promise<void> {
  let pending: { context: OpenClawStateWorkerContext; promise: Promise<void> } | undefined;
  const ensure = async (context: OpenClawStateWorkerContext): Promise<void> => {
    context.admission.assertCurrent();
    if (!owner.isCurrentDatabase(context.admission)) {
      return;
    }
    let previous = pending;
    if (previous) {
      try {
        previous.context.admission.assertCurrent();
        if (previous.context.admission.identity.key !== context.admission.identity.key) {
          previous = undefined;
        }
      } catch {
        previous = undefined;
      }
    }
    if (previous) {
      await previous.promise;
      return ensure(context);
    }
    const state = owner.getState(context.admission);
    if (state.status === "ready") {
      owner.onReady?.();
      return;
    }
    if (state.status === "failed" && !isRegistryRestoreRetryDue(state)) {
      throw state.error;
    }
    const restore = Promise.resolve().then(async () => {
      const receipts: Array<{
        snapshot: Snapshot;
        store: Store;
        reconcile: () => Promise<void>;
      }> = [];
      const reconcile = async () => {
        const errors: unknown[] = [];
        for (let receipt = receipts.shift(); receipt; receipt = receipts.shift()) {
          try {
            if (owner.reconcile) {
              await owner.reconcile(receipt.snapshot, context, receipt.store, receipt.reconcile);
            } else {
              await receipt.reconcile();
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw createSqliteLifecycleAggregateError(
            errors,
            "Registry restore receipt reconciliation failed",
            errors[0],
          );
        }
      };
      let failCurrent: (() => boolean) | undefined;
      try {
        for (;;) {
          failCurrent = undefined;
          context.admission.assertCurrent();
          if (!owner.isCurrentDatabase(context.admission)) {
            await reconcile();
            return;
          }
          const before = owner.getState(context.admission);
          if (before.status === "ready") {
            await reconcile();
            return;
          }
          if (before.status === "failed" && !isRegistryRestoreRetryDue(before)) {
            throw before.error;
          }
          const revision = owner.getRevision();
          const store = owner.getStore();
          const isCurrent = () =>
            owner.isCurrentDatabase(context.admission) &&
            owner.getState(context.admission) === before &&
            owner.getRevision() === revision &&
            owner.getStore() === store;
          let applied = false;
          failCurrent = () => !applied && isCurrent();
          await store.withSnapshotAsync(context, async (snapshot, reconcileSnapshot) => {
            if (owner.reconcile || reconcileSnapshot) {
              receipts.push({ snapshot, store, reconcile: reconcileSnapshot ?? (async () => {}) });
            }
            owner.received?.(snapshot, context, store);
            context.admission.assertCurrent();
            if (!isCurrent()) {
              return;
            }
            const publish = owner.install(snapshot, context);
            applied = true;
            await publish(reconcile);
          });
        }
      } catch (error) {
        let failure = error;
        const secondary: unknown[] = [];
        let admitted = true;
        try {
          context.admission.assertCurrent();
        } catch (admissionError) {
          admitted = false;
          if (admissionError !== error) {
            secondary.push(admissionError);
          }
        }
        // A pre-dispatch capacity refusal leaves preparation available to its bounded retry owner.
        if (admitted && failCurrent?.() && !isSqliteWorkerError(error, "overloaded")) {
          try {
            owner.fail(error, context.admission);
          } catch (restoreError) {
            failure = restoreError;
          }
        }
        try {
          await reconcile();
        } catch (reconciliationError) {
          secondary.push(reconciliationError);
        }
        if (secondary.length > 0) {
          throw createSqliteLifecycleAggregateError(
            [failure, ...secondary],
            `Registry restore failed with additional lifecycle errors: ${formatErrorMessage(failure)}`,
            failure,
          );
        }
        // Superseded projection state cannot make a failed write-capable restore replayable.
        throw failure;
      }
    });
    pending = { context, promise: restore };
    try {
      await restore;
    } finally {
      if (pending?.promise === restore) {
        pending = undefined;
      }
    }
    context.admission.assertCurrent();
    // Publication observers may synchronously reload the registry.
    await ensure(context);
  };
  return ensure;
}
