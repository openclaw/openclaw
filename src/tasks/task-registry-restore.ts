import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

type RestoreState =
  | { status: "uninitialized" | "restoring" | "ready" }
  | { status: "failed"; error: Error };

type SnapshotStore<Snapshot> = {
  withSnapshotAsync<T>(
    context: OpenClawStateWorkerContext,
    consume: (snapshot: Snapshot) => T,
  ): Promise<T>;
};

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
      try {
        await previous.promise;
      } catch (error) {
        context.admission.assertCurrent();
        try {
          previous.context.admission.assertCurrent();
        } catch {
          return ensure(context);
        }
        throw error;
      }
      return ensure(context);
    }
    const state = owner.getState(context.admission);
    if (state.status === "ready") {
      owner.onReady?.();
      return;
    }
    if (state.status === "failed") {
      throw state.error;
    }
    const restore = Promise.resolve().then(async () => {
      const receipts: Array<{ snapshot: Snapshot; store: Store }> = [];
      const reconcile = async () => {
        for (let receipt = receipts.shift(); receipt; receipt = receipts.shift()) {
          await owner.reconcile?.(receipt.snapshot, context, receipt.store);
        }
      };
      for (;;) {
        context.admission.assertCurrent();
        if (!owner.isCurrentDatabase(context.admission)) {
          return;
        }
        const before = owner.getState(context.admission);
        if (before.status === "ready") {
          await reconcile();
          return;
        }
        if (before.status === "failed") {
          try {
            throw before.error;
          } finally {
            await reconcile();
          }
        }
        const revision = owner.getRevision();
        const store = owner.getStore();
        const isCurrent = () =>
          owner.isCurrentDatabase(context.admission) &&
          owner.getState(context.admission) === before &&
          owner.getRevision() === revision &&
          owner.getStore() === store;
        let applied = false;
        try {
          await store.withSnapshotAsync(context, async (snapshot) => {
            if (owner.reconcile) {
              receipts.push({ snapshot, store });
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
        } catch (error) {
          context.admission.assertCurrent();
          if (applied || !owner.isCurrentDatabase(context.admission)) {
            throw error;
          }
          if (isCurrent()) {
            try {
              owner.fail(error, context.admission);
            } finally {
              await reconcile();
            }
          }
        }
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
