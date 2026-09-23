import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureTaskAgentEventCommit } from "./task-registry-agent-event-commit.js";
import {
  prepareTaskAgentEventUpdate,
  type TaskAgentEventInput,
  type TaskAgentEventReceipt,
} from "./task-registry-agent-event.operation.js";
import { hasAuthoritativeTaskBackingInDatabase } from "./task-registry-transition.kernel.js";
import {
  bindTaskRecord,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";

export function observeTaskAgentEventInDatabase(
  database: OpenClawStateDatabase,
  input: TaskAgentEventInput,
): TaskAgentEventReceipt | null {
  let committed: TaskAgentEventReceipt | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const current = readTaskRecord(db, input.taskId);
        if (!current || !hasAuthoritativeTaskBackingInDatabase(db, current)) {
          return null;
        }
        const receipt = prepareTaskAgentEventUpdate(current, input);
        if (!receipt) {
          return null;
        }
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: {
            kind: "task-registry-mutation",
            operation: "tasks.observeAgentEvent",
            taskId: input.taskId,
          },
        });
        const bound = bindTaskRecord(receipt.task);
        upsertTaskRunRowInDatabase({ db }, bound);
        deferSqliteWorkerCommitReceipt(db, captureTaskAgentEventCommit(receipt, bound));
        deferSqlitePostCommitPublication(db, () => {
          committed = receipt;
        });
        return receipt;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "tasks.observeAgentEvent" },
    );
  } catch (error) {
    if (committed) {
      return { ...committed, cleanupError: serializeAgentSchemaInspectionError(error) };
    }
    throw error;
  }
}
