import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  openSharedStateSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerCleanupOperations } from "./openclaw-state-worker-contract.js";

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
  const store = await openSharedStateSqliteWorkerStore<OpenClawStateWorkerCleanupOperations>(
    {
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
      databasePath: params.lease.sharedStatePath,
      existingOnly: true,
    },
    context,
    () => params.assertOwned(),
  );
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
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Retired agent lease cleanup and Worker close failed", {
      cause: errors[0],
    });
  }
}
