import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  parseSupervisedOperation,
  parseSupervisedOperationExecution,
  type SupervisedOperation,
  type SupervisedOperationExecution,
} from "./supervised-operation.types.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);

export function operationRow(value: SupervisedOperation) {
  const operation = parseSupervisedOperation(value);
  return {
    operation_id: operation.operationId,
    flow_id: operation.flowId,
    episode: operation.episode,
    idempotency_key: operation.request.key,
    input_hash: operation.inputHash,
    state: operation.state,
    due_at_ms: operation.dueAt,
    deadline_at_ms: operation.deadlineAt,
    generation: operation.generation,
    record_json: JSON.stringify(operation),
  };
}

export function executionRow(value: SupervisedOperationExecution) {
  const execution = parseSupervisedOperationExecution(value);
  return {
    execution_id: execution.executionId,
    operation_id: execution.operationId,
    generation: execution.generation,
    owner_id: execution.ownerId,
    lease_expires_at_ms: execution.leaseExpiresAt,
    dispatched_at_ms: execution.dispatchedAt,
    finished_at_ms: execution.finishedAt,
    record_json: JSON.stringify(execution),
  };
}

export function readOperation(
  db: DatabaseSync,
  operationId: string,
): SupervisedOperation | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db).selectFrom("task_flow_operations").selectAll().where("operation_id", "=", operationId),
  );
  if (!row) {
    return undefined;
  }
  const operation = parseSupervisedOperation(JSON.parse(row.record_json));
  if (
    JSON.stringify(operationRow(operation)) !==
    JSON.stringify({ ...operationRow(operation), ...row })
  ) {
    throw new Error("Operation projection disagrees with canonical record");
  }
  return operation;
}

export function readExecution(
  db: DatabaseSync,
  executionId: string,
): SupervisedOperationExecution | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operation_executions")
      .selectAll()
      .where("execution_id", "=", executionId),
  );
  if (!row) {
    return undefined;
  }
  const execution = parseSupervisedOperationExecution(JSON.parse(row.record_json));
  if (
    JSON.stringify(executionRow(execution)) !==
    JSON.stringify({ ...executionRow(execution), ...row })
  ) {
    throw new Error("Execution projection disagrees with canonical record");
  }
  return execution;
}

export function saveOperation(
  db: DatabaseSync,
  previous: SupervisedOperation,
  next: SupervisedOperation,
): SupervisedOperation {
  if (previous.outcome) {
    throw new Error("Operation receipt is immutable");
  }
  const row = operationRow(next);
  const result = executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("task_flow_operations")
      .set(row)
      .where("operation_id", "=", previous.operationId)
      .where("record_json", "=", operationRow(previous).record_json),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error("Operation ownership changed");
  }
  return next;
}

export function saveExecution(
  db: DatabaseSync,
  previous: SupervisedOperationExecution,
  next: SupervisedOperationExecution,
): void {
  if (previous.outcome) {
    throw new Error("Execution observation is immutable");
  }
  const result = executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("task_flow_operation_executions")
      .set(executionRow(next))
      .where("execution_id", "=", previous.executionId)
      .where("record_json", "=", executionRow(previous).record_json),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error("Execution ownership changed");
  }
}

export function exactExecution(
  db: DatabaseSync,
  expected: SupervisedOperationExecution,
): SupervisedOperationExecution {
  const execution = readExecution(db, expected.executionId);
  if (
    !execution ||
    execution.operationId !== expected.operationId ||
    execution.generation !== expected.generation ||
    execution.ownerId !== expected.ownerId
  ) {
    throw new Error("Operation execution identity changed");
  }
  return execution;
}

export function getSupervisedOperation(
  operationId: string,
  options: Options = {},
): SupervisedOperation | undefined {
  return readSupervisedWorkflow(
    (db) => (tableExists(db, "task_flow_operations") ? readOperation(db, operationId) : undefined),
    options,
  );
}

export function getSupervisedOperationExecution(
  executionId: string,
  options: Options = {},
): SupervisedOperationExecution | undefined {
  return readSupervisedWorkflow(
    (db) =>
      tableExists(db, "task_flow_operation_executions")
        ? readExecution(db, executionId)
        : undefined,
    options,
  );
}

/** Review receipts/replay cannot turn missing custody into extinction evidence.
 * Existing identical terminal observations are checked before invoking this. */
export function assertReviewRuntimeClosed(
  db: DatabaseSync,
  operation: SupervisedOperation,
  execution: SupervisedOperationExecution,
): void {
  if (operation.request.kind !== "review") {
    return;
  }
  const resource = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_command_resources")
      .select("state")
      .where("execution_id", "=", execution.executionId),
  );
  if ((resource && resource.state !== "closed") || (execution.dispatchedAt !== null && !resource)) {
    throw new Error("Review runtime closure remains unresolved");
  }
}
