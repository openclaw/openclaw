import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  workerEnvironmentProjections,
  type WorkerEnvironmentNativePatch,
} from "./store-projection.js";
import type { WorkerEnvironmentFacts } from "./store.types.js";

/** Reserve order while the caller holds the physical writer lock or grants its worker commit. */
export function reserveWorkerEnvironmentNativePublication(identity: DatabasePathIdentity) {
  const owner = workerEnvironmentProjections.get(identity);
  if (!owner?.active) {
    return undefined;
  }
  const revision = owner.nextSequence();
  return (environmentId: string, patch: WorkerEnvironmentNativePatch): boolean => {
    if (!owner.active || workerEnvironmentProjections.get(identity) !== owner) {
      return false;
    }
    owner.publishPatch(environmentId, patch, revision);
    return true;
  };
}

/** Pairing and placement keep their atomic writes, then publish through the inventory owner. */
export function publishWorkerEnvironmentNativeMutation(
  db: DatabaseSync,
  environmentId: string,
  patch: WorkerEnvironmentNativePatch,
): void {
  const publish = reserveWorkerEnvironmentNativePublication(
    requireOpenClawStateDatabaseIdentity({ db }),
  );
  if (!publish) {
    return;
  }
  const captured = structuredClone(patch);
  if (
    !stageSqliteTransactionState(db, {
      stage() {},
      rollback() {},
      commit() {
        publish(environmentId, captured);
      },
    })
  ) {
    throw new Error("Worker environment publication requires its owning transaction");
  }
  sessionChanges.emit({ all: true, scope: "worker-environments" }, db);
}

/** Exact-ID recovery belongs to the inventory owner, including coupled placement commits. */
export async function reconcilePendingWorkerEnvironmentMutations(params: {
  owner: NonNullable<ReturnType<typeof workerEnvironmentProjections.get>>;
  assertCurrent: () => void;
  snapshot: (ids: readonly string[]) => Promise<WorkerEnvironmentFacts>;
}) {
  const { owner } = params;
  for (const recovery of owner.pendingReconciliations()) {
    try {
      params.assertCurrent();
      const revision = owner.nextSequence();
      const facts = await params.snapshot(recovery.ids);
      params.assertCurrent();
      owner.install(facts, revision, false);
      owner.release(recovery.token);
      if (
        recovery.revocationId &&
        !facts.credentials.some((credential) => credential.environmentId === recovery.revocationId)
      ) {
        owner.publishCredentialRevoked(recovery.revocationId);
      }
      sessionChanges.emit({ all: true, scope: "worker-environments" });
    } catch (error) {
      throw new AggregateError(
        [recovery.error, error],
        "Worker environment mutation failed and inventory reconciliation failed",
        { cause: error },
      );
    }
  }
}
