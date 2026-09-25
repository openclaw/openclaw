import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { SupervisedOperationRequest } from "./supervised-operation.types.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import { insertSupervisedWorkflowRootInTransaction } from "./supervised-workflow-root.js";
import {
  readSupervisedWorkflow,
  SupervisedRecordCorruptionError,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import {
  authorizeSupervisedWorkflowRequest,
  encodeSupervisedWorkflowContract,
} from "./supervised-workflow.types.js";

export function insertSupervisedWorkflowContractInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  value: unknown,
): void {
  const encoded = encodeSupervisedWorkflowContract(value, task.goal);
  if (!task.goal) {
    throw new Error("Managed workflow requires accepted criteria before admission");
  }
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db).insertInto("task_flow_contracts").values({
      flow_id: task.flowId,
      episode: task.episode,
      contract_hash: encoded.hash,
      workspace: encoded.contract.workspace,
      record_json: encoded.json,
    }),
  );
  insertSupervisedWorkflowRootInTransaction(db, task, encoded.contract.workspace);
}

export function readSupervisedWorkflowContractInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
) {
  if (!tableExists(db, "task_flow_contracts")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("task_flow_contracts")
      .selectAll()
      .where("flow_id", "=", flowId)
      .where("episode", "=", episode),
  );
  if (!row) {
    return undefined;
  }
  try {
    const encoded = encodeSupervisedWorkflowContract(JSON.parse(row.record_json));
    if (
      encoded.json !== row.record_json ||
      encoded.hash !== row.contract_hash ||
      encoded.contract.workspace !== row.workspace
    ) {
      throw new Error("Accepted workflow contract is corrupt");
    }
    return encoded;
  } catch (cause) {
    throw new SupervisedRecordCorruptionError("Accepted workflow contract is corrupt", { cause });
  }
}

export function getSupervisedWorkflowContract(
  flowId: string,
  episode: number,
  options: Options = {},
) {
  return readSupervisedWorkflow(
    (db) => readSupervisedWorkflowContractInTransaction(db, flowId, episode),
    options,
  );
}

export function authorizeSupervisedOperationInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  request: SupervisedOperationRequest,
) {
  const encoded = readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode);
  if (!encoded) {
    throw new Error("Task has no accepted operation contract");
  }
  authorizeSupervisedWorkflowRequest(encoded.contract, request);
  return encoded;
}
