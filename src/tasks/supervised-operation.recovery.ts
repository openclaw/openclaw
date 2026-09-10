import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { readExecution, readOperation } from "./supervised-operation.persistence.js";
import type { SupervisedOperation } from "./supervised-operation.types.js";
import { quarantineSupervisedTaskInTransaction } from "./supervised-task.recovery.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const active = ["queued", "running", "reconciling"];

export function listSupervisedOperations(
  options: Options = {},
  flowId?: string,
  episode?: number,
): SupervisedOperation[] {
  return (
    readSupervisedWorkflow(
      (db) => listSupervisedOperationsInTransaction(db, flowId, episode),
      options,
    ) ?? []
  );
}

export function listSupervisedOperationsInTransaction(
  db: DatabaseSync,
  flowId?: string,
  episode?: number,
): SupervisedOperation[] {
  if (!tableExists(db, "task_flow_operations")) {
    return [];
  }
  let query = selectUnquarantinedOperations(db).select("operation_id");
  if (flowId) {
    query = query.where("flow_id", "=", flowId);
  } else {
    query = query.where("state", "in", active);
  }
  if (episode !== undefined) {
    query = query.where("episode", "=", episode);
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy("due_at_ms").orderBy("operation_id").limit(256),
  ).rows.map((row) => readOperation(db, row.operation_id)!);
}

function selectUnquarantinedOperations(db: DatabaseSync) {
  let query = sql(db).selectFrom("task_flow_operations");
  if (tableExists(db, "task_flow_recovery")) {
    query = query.where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("task_flow_recovery as recovery")
            .select("recovery.flow_id")
            .whereRef("recovery.flow_id", "=", "task_flow_operations.flow_id")
            .whereRef("recovery.episode", "=", "task_flow_operations.episode")
            .where("recovery.fault_json", "is not", null),
        ),
      ),
    );
  }
  return query;
}

/** Validate canonical operation/execution/contract records one at a time before
 * the dispatcher decodes its page. Faults retain original bytes and revoke only
 * the affected episode; filtering precedes pagination on subsequent sweeps. */
function validateOperationRecords(db: DatabaseSync, operationId: string) {
  const operation = readOperation(db, operationId);
  if (!operation || operation.outcome) {
    return;
  }
  const contract = readSupervisedWorkflowContractInTransaction(
    db,
    operation.flowId,
    operation.episode,
  );
  if (!contract || contract.hash !== operation.contractHash) {
    throw new Error("Operation contract mismatch");
  }
  if (operation.executionId) {
    const execution = readExecution(db, operation.executionId);
    if (
      !execution ||
      execution.operationId !== operation.operationId ||
      execution.generation !== operation.generation
    ) {
      throw new Error("Operation execution mismatch");
    }
  }
}

export function reconcileSupervisedOperationRecords(
  now: number,
  options: Options = {},
  flowId?: string,
) {
  const suspects =
    readSupervisedWorkflow((db) => {
      if (!tableExists(db, "task_flow_operations")) {
        return [];
      }
      let query = selectUnquarantinedOperations(db)
        .select(["operation_id", "flow_id", "episode"])
        .where("state", "in", active);
      if (flowId) {
        query = query.where("flow_id", "=", flowId);
      }
      return executeSqliteQuerySync(
        db,
        query.orderBy("due_at_ms").orderBy("operation_id").limit(256),
      ).rows.filter((row) => {
        try {
          validateOperationRecords(db, row.operation_id);
          return false;
        } catch {
          return true;
        }
      });
    }, options) ?? [];
  // Healthy observations are read-only. Reread suspect records under the writer
  // before fencing their episode: an already-repaired row is no longer a fault.
  for (const row of suspects) {
    writeSupervisedWorkflow((db) => {
      try {
        validateOperationRecords(db, row.operation_id);
      } catch {
        quarantineSupervisedTaskInTransaction(db, row.flow_id, row.episode, now, row.operation_id);
      }
    }, options);
  }
}
