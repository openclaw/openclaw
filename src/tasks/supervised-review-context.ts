import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  assertSupervisedOperationCurrent,
  getSupervisedOperation,
  getSupervisedOperationExecution,
} from "./supervised-operation.store.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions,
} from "./supervised-workflow.persistence.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";
import { authorizeSupervisedWorkflowRequest } from "./supervised-workflow.types.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";

/** Arguments select persisted host facts, never supply a model-authored launch
 * profile or arbitrary writable export path. */
export function readSupervisedReviewContext(
  executionId: string,
  allocationId: string,
  options: SupervisedWorkflowDatabaseOptions,
) {
  const execution = getSupervisedOperationExecution(executionId, options);
  if (!execution) {
    throw new Error("Review execution missing");
  }
  assertSupervisedOperationCurrent(execution, Date.now(), options);
  const operation = getSupervisedOperation(execution.operationId, options);
  if (!operation?.workspaceVersion) {
    throw new Error("Review input version is not pinned");
  }
  const accepted = getSupervisedWorkflowContract(operation.flowId, operation.episode, options);
  if (!accepted || accepted.hash !== operation.contractHash) {
    throw new Error("Review contract changed");
  }
  const { profile } = authorizeSupervisedWorkflowRequest(accepted.contract, operation.request);
  if (profile.kind !== "review") {
    throw new Error("Execution is not an accepted review");
  }
  const allocation = readSupervisedWorkflow(
    (db) =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_workspace_allocations")
          .selectAll()
          .where("allocation_id", "=", allocationId),
      ),
    options,
  );
  if (
    !allocation ||
    allocation.owner_kind !== "operation" ||
    allocation.owner_id !== executionId ||
    allocation.flow_id !== operation.flowId ||
    allocation.episode !== operation.episode ||
    allocation.kind !== "draft" ||
    allocation.state !== "reserved" ||
    allocation.owner_pid !== execution.process?.pid ||
    allocation.owner_start_time !== execution.process.startTime
  ) {
    throw new Error("Review export lacks its exact runner-owned allocation");
  }
  return {
    execution,
    operation,
    profile,
    contract: {
      ...accepted.contract,
      workspace: supervisedWorkspaceVersionPath(operation.workspaceVersion, options),
    },
    reservedRoot: supervisedWorkspaceVersionPath(allocationId, options),
  };
}
