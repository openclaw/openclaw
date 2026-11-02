import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import {
  acquireStateDatabaseSchemaLease,
  GatewayStateOwnerContentionError,
  getStateDatabaseSchemaLease,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
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

/** Ordinary transactions use SQLite; schema changes retain the installation's process owner. */
export function withStateDatabaseSchemaMaintenance<T>(
  { databasePath, busyTimeoutMs }: { databasePath: string; busyTimeoutMs?: number },
  operation: () => T,
): T {
  if (requestSqliteWorkerSchemaMaintenance(databasePath)) {
    return operation();
  }
  const canonical = resolveIdentityPathViaExistingAncestorSync(databasePath);
  const inherited = getStateDatabaseSchemaLease(canonical);
  if (inherited) {
    inherited.assertCurrent();
    return operation();
  }
  let lease: StateDatabaseSchemaLease;
  try {
    lease = acquireStateDatabaseSchemaLease(canonical, { busyTimeoutMs });
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      throw new StateSchemaMutationConflictError(canonical, error);
    }
    throw error;
  }
  return runWithSqliteCleanup(lease, "state schema mutation", () => lease.run(operation));
}
