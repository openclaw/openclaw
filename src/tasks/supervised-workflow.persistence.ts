import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

export type SupervisedWorkflowDatabaseOptions = OpenClawStateDatabaseOptions;

/** Decode/identity failure in persisted bytes, never a database or filesystem failure. */
export class SupervisedRecordCorruptionError extends Error {}

const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS task_flow_episodes (");
const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS flow_runs (", start);
if (start < 0 || end < start) {
  throw new Error("Supervised workflow canonical schema missing");
}
const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end);

export function writeSupervisedWorkflow<T>(
  operation: (db: DatabaseSync) => T,
  options: SupervisedWorkflowDatabaseOptions,
): T {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(schema); // sqlite-allow-raw -- Canonical first-use supervision DDL, inside the admitting transaction.
      return operation(db);
    },
    options,
    { operationLabel: "taskflow.workflow" },
  );
}

export function readSupervisedWorkflow<T>(
  operation: (db: DatabaseSync) => T,
  options: SupervisedWorkflowDatabaseOptions,
): T | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => runSqliteDeferredTransactionSync(db, () => operation(db)),
    options,
  );
}
