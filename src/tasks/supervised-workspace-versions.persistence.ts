import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import type { SupervisedWorkflowContract } from "./supervised-workflow.types.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";

/** Read side of the workspace head, owned below version commitment: acceptance
 * verification resolves the accepted artifact without depending on the module
 * that clones, commits and prunes versions. Version commitment re-exports these
 * readers so callers keep one canonical entry point. */

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);

export function readSupervisedWorkspaceHeadInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
) {
  if (!tableExists(db, "task_flow_workspace_heads")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_workspace_heads as h")
      .innerJoin("task_flow_workspace_versions as v", "v.version_id", "h.version_id")
      .select(["v.version_id", "v.source_hash", "v.byte_count"])
      .where("h.flow_id", "=", flowId)
      .where("h.episode", "=", episode),
  );
}

export function getSupervisedWorkspaceHead(flowId: string, episode: number, options: Options = {}) {
  return readSupervisedWorkflow(
    (db) => readSupervisedWorkspaceHeadInTransaction(db, flowId, episode),
    options,
  );
}

export function resolveSupervisedWorkflowWorkspace(
  contract: SupervisedWorkflowContract,
  flowId: string,
  episode: number,
  options: Options = {},
) {
  const head = getSupervisedWorkspaceHead(flowId, episode, options);
  return {
    ...contract,
    workspace: head ? supervisedWorkspaceVersionPath(head.version_id, options) : contract.workspace,
  };
}
