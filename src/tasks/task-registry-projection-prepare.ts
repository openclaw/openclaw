import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { reconcileTaskRegistrySnapshot } from "./task-registry-worker-publication.js";
import {
  getTaskRegistryProcessState,
  recordTaskRegistryReadCompletion,
} from "./task-registry.process-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";

export function createTaskRegistryProjectionPreparation(owner: {
  ensureReady: (context: OpenClawStateWorkerContext) => Promise<void>;
  assertCurrent: (context: OpenClawStateWorkerContext, store: TaskRegistryStore) => void;
  installSnapshot: (
    snapshot: TaskRegistryStoreSnapshot,
    scope?: TaskRegistryMutationScope | readonly TaskRegistryMutationScope[],
  ) => void;
  markRestored: (scopes?: readonly TaskRegistryMutationScope[]) => void;
}) {
  const { projection } = getTaskRegistryProcessState();
  let pending:
    | {
        databaseKey: string;
        store: TaskRegistryStore;
        epoch: number;
        result: Promise<boolean>;
      }
    | undefined;

  return async (
    context: OpenClawStateWorkerContext,
    store: TaskRegistryStore,
    maxAttempts = Number.POSITIVE_INFINITY,
  ): Promise<boolean> => {
    owner.assertCurrent(context, store);
    await owner.ensureReady(context);
    owner.assertCurrent(context, store);
    let attempts = 0;
    while (
      projection.mutationDepth === 0 &&
      (projection.dirty || projection.dirtyScopes.size > 0)
    ) {
      if (attempts++ >= maxAttempts) {
        return false;
      }
      const epoch = projection.epoch;
      const databaseKey = context.admission.identity.key;
      let preparation = pending;
      // Duplicate refreshes advance the epoch and invalidate one another despite unchanged rows.
      if (
        !preparation ||
        preparation.databaseKey !== databaseKey ||
        preparation.store !== store ||
        preparation.epoch !== epoch
      ) {
        const scopes = projection.dirty ? undefined : [...projection.dirtyScopes];
        const capturedScopes = new Set(scopes);
        const result = scopes
          ? reconcileTaskRegistrySnapshot({
              scopes,
              assertCurrent: () => owner.assertCurrent(context, store),
              read: () => store.loadMutationSnapshotAsync(context, scopes),
              consume({ snapshot, divergentScopes }) {
                // Witnesses preserve newer publications, but cannot prepare new dirty obligations.
                if (
                  projection.dirty ||
                  [...projection.dirtyScopes].some((scope) => !capturedScopes.has(scope))
                ) {
                  return false;
                }
                owner.installSnapshot(snapshot, scopes);
                // A preserved projection may precede an orphaned disk write in this scope.
                const restoredScopes = scopes.filter((scope) => !divergentScopes.has(scope));
                owner.markRestored(restoredScopes);
                recordTaskRegistryReadCompletion(restoredScopes);
                const pendingScopes = new Set(
                  Array.from(projection.pending, (mutation) => mutation.scope),
                );
                return [...projection.dirtyScopes].every((scope) => pendingScopes.has(scope));
              },
            })
          : store.loadMutationSnapshotAsync(context).then((snapshot) => {
              owner.assertCurrent(context, store);
              if (epoch !== projection.epoch) {
                return false;
              }
              owner.installSnapshot(snapshot);
              owner.markRestored();
              return true;
            });
        preparation = { databaseKey, store, epoch, result };
        pending = preparation;
      }
      try {
        const prepared = await preparation.result;
        owner.assertCurrent(context, store);
        if (prepared) {
          return true;
        }
      } finally {
        if (pending === preparation) {
          pending = undefined;
        }
      }
    }
    return true;
  };
}
