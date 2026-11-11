import { withSqliteDatabaseAdmissionExchange } from "./sqlite-database-admission.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import {
  exchangeDatabaseAdmissions,
  exchangeSqliteDatabaseAdmissions,
  getSqliteDatabaseAdmissionUpstream,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-worker-database-admission-relay.js";
import {
  currentSqliteWorkerOperationAdmission as currentAdmission,
  type SqliteWorkerOperationContext,
  type WorkerAdmissionScope,
} from "./sqlite-worker-operation-settlement.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-writer-admission-client.js";

/** Install only the private port belonging to the broker's currently executing operation. */
export function withSqliteWorkerOperationAdmission<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T,
): T {
  const scope = { owner, port: owner.port, active: true };
  try {
    return runSqliteWorkerAdmissionScope(scope, operation);
  } finally {
    scope.active = false;
  }
}

/** Async factories and cleanup retain the same grant until their accepted work settles. */
export async function withSqliteWorkerOperationAdmissionAsync<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  const scope = { owner, port: owner.port, active: true };
  try {
    return await runSqliteWorkerAdmissionScope(scope, operation);
  } finally {
    scope.active = false;
  }
}

function runSqliteWorkerAdmissionScope<T>(scope: WorkerAdmissionScope, operation: () => T): T {
  return withSqliteDatabaseAdmissionWait(
    { deadlineAtMs: scope.owner.databaseAdmissionDeadlineAtMs },
    () =>
      currentAdmission.run(scope, () =>
        withSqliteDatabaseAdmissionExchange((admissions, location, create) => {
          if (!scope.active) {
            const upstream = getSqliteDatabaseAdmissionUpstream();
            if (create || !upstream || upstream.closed) {
              throw new SqliteWorkerError(
                "SQLite facts require their retained admission",
                "unavailable",
              );
            }
            // Retained cleanup may publish facts; creation still needs the live grant.
            return exchangeDatabaseAdmissions(upstream.port, admissions, location);
          }
          return exchangeSqliteDatabaseAdmissions(scope.port, admissions, location, create);
        }, operation),
      ),
  );
}

/** Schema work borrows live host authority through the same retained job port. */
export function requestSqliteWorkerSchemaMaintenance(databasePath: string): boolean {
  if (!currentAdmission.getStore()) {
    return false;
  }
  requestSqliteWorkerOperationAdmission({
    stage: "prepare",
    facts: { kind: "schema-maintenance", databasePath },
  });
  return true;
}

/** Require owner-prepared data carried by this operation's command envelope. */
export function takeSqliteWorkerOperationAdmissionAttachment(): unknown {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  if (!scope.owner.attachment) {
    throw new SqliteWorkerError("SQLite operation attachment is unavailable", "unavailable");
  }
  return scope.owner.attachment.value;
}
