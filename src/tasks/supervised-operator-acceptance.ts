import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
export function readSupervisedOperatorAcceptance(
  db: DatabaseSync,
  params: { flowId: string; criterionId: string; contractHash: string; sourceHash: string },
) {
  if (!tableExists(db, "task_flow_operator_acceptance")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("task_flow_operator_acceptance")
      .selectAll()
      .where("flow_id", "=", params.flowId)
      .where("criterion_id", "=", params.criterionId)
      .where("contract_hash", "=", params.contractHash)
      .where("source_hash", "=", params.sourceHash)
      .orderBy("accepted_at_ms", "desc")
      .orderBy("approval_id")
      .limit(1),
  );
}
export function getSupervisedOperatorAcceptance(
  params: Parameters<typeof readSupervisedOperatorAcceptance>[1],
  options: Options = {},
) {
  return readSupervisedWorkflow((db) => readSupervisedOperatorAcceptance(db, params), options);
}
