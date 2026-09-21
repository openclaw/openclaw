import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  runWithOpenClawStateBusyTimeout,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

export type OpenClawStateLeaseDatabase = {
  scope: "shared";
  options?: OpenClawStateDatabaseOptions;
  /** Storage compatibility only, never authority. Acquisition still claims the real lease. */
  schemaPolicy?: "existing";
};
const leaseSchema = ["schema_meta", "state_leases"]
  .map((table) =>
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
      endMarker: ") STRICT;",
      errorMessage: "Existing lease schema is unavailable.",
    }),
  )
  .join("\n");

export function prepareLeaseDatabase(database: OpenClawStateLeaseDatabase): void {
  if (database.schemaPolicy !== "existing") {
    runWithOpenClawStateBusyTimeout(() => undefined, database.options ?? {}, 0);
  }
}

export function resolveLeaseDatabasePath(database: OpenClawStateLeaseDatabase): string {
  return database.schemaPolicy === "existing"
    ? path.resolve(database.options?.path ?? resolveOpenClawStateSqlitePath(database.options?.env))
    : openOpenClawStateDatabase(database.options).path;
}
export function readLeaseDatabase<T>(
  database: OpenClawStateLeaseDatabase,
  operation: (db: DatabaseSync) => T,
): T {
  return database.schemaPolicy === "existing"
    ? withOpenClawStateDatabaseReadOnly(({ db }) => operation(db), database.options)
    : operation(openOpenClawStateDatabase(database.options).db);
}

export async function acquireLease(
  database: OpenClawStateLeaseDatabase,
  input: { identity: OpenClawStateLeaseIdentity; leaseMs: number; operationLabel: string },
  assertCurrent: () => void,
) {
  if (database.options?.readOnly) {
    throw new Error("State lease acquisition requires writable storage");
  }
  if (database.schemaPolicy === "existing" && database.options?.database) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const opened =
    database.schemaPolicy === "existing" ? undefined : openOpenClawStateDatabase(database.options);
  const context = captureOpenClawStateWorkerContext({
    ...database.options,
    path: opened?.path ?? resolveLeaseDatabasePath(database),
  });
  const assertAdmission = () => {
    context.admission.assertCurrent();
    assertCurrent();
    // The worker cannot join a transaction held by the caller's verification handle.
    if (opened?.db.isTransaction) {
      throw new OpenClawStateLeaseError("State lease acquisition requires no active transaction", {
        code: "OPENCLAW_STATE_LEASE_INVALID_INPUT",
      });
    }
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "stateLease.acquire",
        input: { ...input, schemaPolicy: database.schemaPolicy },
      }),
    {
      existingOnly: database.schemaPolicy === "existing",
      assertCurrent: assertAdmission,
      createAdmission: createSqliteWorkerWriteAdmission(assertAdmission, [
        context.admission.databasePath,
      ]),
    },
  );
  if (!result) {
    throw new Error("State lease acquisition requires an existing database");
  }
  return result;
}
export function withLeaseWriteTransaction<T>(
  database: OpenClawStateLeaseDatabase,
  operationLabel: string,
  operation: (db: DatabaseSync) => T,
  busyTimeoutMs = 0,
): T {
  if (database.schemaPolicy === "existing") {
    return runExistingOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      database.options ?? {},
      { operationLabel, busyTimeoutMs, schemaSql: leaseSchema },
    );
  }
  const stateDatabase = openOpenClawStateDatabase(database.options);
  const run = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      { ...database.options, database: stateDatabase },
      { operationLabel, busyTimeoutMs },
    );
  return runWithSqliteBusyTimeout(stateDatabase.db, busyTimeoutMs, run);
}
