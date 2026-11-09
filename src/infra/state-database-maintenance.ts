import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import {
  acquireStateDatabaseSchemaLease,
  GatewayStateOwnerContentionError,
  getStateDatabaseSchemaLease,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCleanup,
  SqliteCoordinatorError,
} from "./sqlite-lifecycle-errors.js";
import { requestSqliteWorkerSchemaMaintenance } from "./sqlite-worker-operation-admission.js";

export const StateSchemaMutationConflictError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSchemaMutationConflictError"),
  () =>
    class SchemaMutationConflictError extends Error {
      constructor(databasePath: string, cause: unknown) {
        super(
          `OpenClaw refused shared state schema mutation at ${databasePath} because another Gateway owns that state directory. Stop that Gateway or perform the update through its managed restart path, then retry.`,
          { cause },
        );
        this.name = "StateSchemaMutationConflictError";
      }
    },
);

/** Only a newly acquired lease belongs to this call's cleanup. */
function acquireSchemaMaintenanceLease({
  databasePath,
  busyTimeoutMs,
}: {
  databasePath: string;
  busyTimeoutMs?: number;
}): StateDatabaseSchemaLease | undefined {
  if (requestSqliteWorkerSchemaMaintenance(databasePath)) {
    return undefined;
  }
  const canonical = resolveIdentityPathViaExistingAncestorSync(databasePath);
  const inherited = getStateDatabaseSchemaLease(canonical);
  if (inherited) {
    inherited.assertCurrent();
    return undefined;
  }
  try {
    return acquireStateDatabaseSchemaLease(canonical, { busyTimeoutMs });
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      throw new StateSchemaMutationConflictError(canonical, error);
    }
    throw error;
  }
}

/** Ordinary transactions use SQLite; schema changes retain the installation's process owner. */
export function withStateDatabaseSchemaMaintenance<T>(
  options: { databasePath: string; busyTimeoutMs?: number },
  operation: () => T,
): T {
  const lease = acquireSchemaMaintenanceLease(options);
  if (!lease) {
    return operation();
  }
  return runWithSqliteCleanup(lease, "state schema mutation", () => lease.run(operation));
}

/** Prepare asynchronous repair artifacts under the same lease as the later schema mutation. */
export async function withStateDatabaseSchemaMaintenanceAsync<T>(
  options: { databasePath: string; busyTimeoutMs?: number },
  operation: () => T | Promise<T>,
): Promise<T> {
  const lease = acquireSchemaMaintenanceLease(options);
  if (!lease) {
    return await operation();
  }
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await lease.run(operation) };
  } catch (error) {
    outcome = { error };
  }
  try {
    lease.release();
  } catch (releaseError) {
    if ("error" in outcome) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, releaseError],
        "state schema mutation and resource release both failed",
        outcome.error,
      );
    }
    throw new SqliteCoordinatorError(
      "state schema mutation completed, but releasing its resource failed",
      releaseError,
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
