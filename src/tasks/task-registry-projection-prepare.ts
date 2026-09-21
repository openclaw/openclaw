import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
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
  markRestored: () => void;
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
        const result = store.loadMutationSnapshotAsync(context, scopes).then((snapshot) => {
          owner.assertCurrent(context, store);
          if (epoch !== projection.epoch) {
            return false;
          }
          owner.installSnapshot(snapshot, scopes);
          // In-flight mutations retain their publication obligations after this read.
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
