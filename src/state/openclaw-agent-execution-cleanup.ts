import { throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import { readDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { runSqliteWorkerStoreOperation } from "../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { openOpenClawStateWorkerCleanupStore } from "./openclaw-state-worker-store.js";

/** Release only this owner's prepared lease after the broker certifies native retirement. */
export async function cleanupRetiredAgentDatabaseLease(params: {
  context: OpenClawStateWorkerContext;
  stopped: Promise<void>;
  assertOwned(): void;
  lease: OpenClawAgentDatabaseWorkerLeaseReceipt;
}): Promise<void> {
  params.assertOwned();
  await params.stopped;
  params.assertOwned();
  const observed = await readDatabasePathIdentity(params.lease.sharedStatePath);
  if (observed.key !== params.lease.sharedStateIdentity) {
    throw new Error("Retired agent cleanup cannot adopt a replacement shared database");
  }
  const context = {
    environment: params.context.environment,
    coordinatorRuntime: { ...params.context.coordinatorRuntime, keepAlive: false },
    existingSchemaPath: params.context.existingSchemaPath,
  };
  const store = await openOpenClawStateWorkerCleanupStore(
    params.lease.sharedStatePath,
    context,
    () => params.assertOwned(),
  ).catch((error: unknown) => {
    if (error instanceof Error) {
      error.message += ` (leaseId=${params.lease.leaseId}, path=${params.lease.path})`;
      error.stack = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
    }
    throw error;
  });
  if (!store) {
    throw new Error("Retired agent cleanup lost its original shared database");
  }
  const errors: unknown[] = [];
  try {
    await runSqliteWorkerStoreOperation(
      store,
      (scope) => scope.execute({ type: "agentDatabases.releaseExitedLease", input: params.lease }),
      context,
      () => params.assertOwned(),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await store.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Retired agent lease cleanup and Worker close failed");
}
