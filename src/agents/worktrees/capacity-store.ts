import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { readDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { runSqliteWorkerStoreOperation } from "../../infra/sqlite-worker-store.js";
import { runWithOpenClawStateLeasesWorker } from "../../state/openclaw-state-lease-worker-operation.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
  type WorktreeCapacityRequest,
  type WorktreeCapacityResult,
} from "./capacity-contract.js";
import type { WorktreeLeaseSet, WorktreeRegistryPredicate } from "./types.js";

export async function reserveWorktreeCapacity(params: {
  leaseSet: WorktreeLeaseSet;
  request: WorktreeCapacityRequest;
  predicates?: readonly WorktreeRegistryPredicate[];
  assertCurrent: () => void;
}): Promise<WorktreeCapacityResult> {
  return await runWithOpenClawStateLeasesWorker(
    params.leaseSet.leases,
    params.leaseSet.context,
    (scope, leases) =>
      scope.execute({
        type: "worktrees.reserveCapacity",
        input: { ...params.request, leases, predicates: params.predicates },
      }),
    { assertCurrent: params.assertCurrent, beforeCommit: params.assertCurrent },
  );
}

/** Exact-token release outlives caller cancellation, after the allocation owner joined native work. */
export async function releaseWorktreeCapacity(params: {
  context: OpenClawStateWorkerContext;
  key: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { openOpenClawStateWorkerCleanupStore } =
    await import("../../state/openclaw-state-worker-store.js");
  const databasePath = params.context.admission.databasePath;
  const identity = await readDatabasePathIdentity(databasePath);
  if (identity.key !== params.context.admission.identity.key) {
    throw new Error("Managed worktree reservation cleanup cannot adopt a replacement database");
  }
  params.assertCurrent();
  const cleanupContext = {
    environment: params.context.environment,
    existingSchemaPath: params.context.existingSchemaPath,
    stateIntegrity: params.context.stateIntegrity,
  };
  const store = await openOpenClawStateWorkerCleanupStore(
    databasePath,
    cleanupContext,
    params.assertCurrent,
    identity,
  );
  if (!store) {
    throw new Error("Managed worktree reservation cleanup lost its original database");
  }
  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
  const errors: unknown[] = [];
  try {
    await runSqliteWorkerStoreOperation(
      store,
      (scope) =>
        scope.execute({
          type: "stateLease.release",
          input: {
            identity: {
              scope: WORKTREE_CAPACITY_RESERVATION_SCOPE,
              key: params.key,
              owner: params.key,
            },
            databaseIdentity: identity.key,
            operationLabel: "agents.worktrees.capacity-release",
          },
        }),
      cleanupContext,
      params.assertCurrent,
      (operation) => {
        settled = operation.settled;
        return {
          nativeLocations: [databasePath],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            params.assertCurrent();
            grant();
          }),
        };
      },
    );
  } catch (error) {
    errors.push(error);
  } finally {
    await settled;
  }
  try {
    await store.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(
    errors,
    "Managed worktree reservation release and worker close failed",
  );
}
