import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  workerEnvironmentProjections,
  type WorkerEnvironmentNativePatch,
} from "./store-projection.js";

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
