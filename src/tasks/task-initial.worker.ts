import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  createInitialTaskFlowInDatabase,
  deleteUnlinkedInitialTaskFlowInDatabase,
  finalizeInitialTaskManagedCancellationInDatabase,
  linkInitialTaskFlowInDatabase,
} from "./task-initial-flow.kernel.js";
import type {
  TaskInitialWorkerCommand,
  TaskInitialWorkerOperations,
} from "./task-initial-worker.types.js";
import {
  acknowledgeTaskStateNotificationInDatabase,
  updateTaskNotificationDeliveryInDatabase,
} from "./task-notification.kernel.js";
import { captureTaskCreationEventTarget } from "./task-registry-agent-event-target.js";
import { createTaskRecordInDatabase } from "./task-registry-create.kernel.js";
import { transitionTaskRecordInDatabase } from "./task-registry-transition.kernel.js";
import { readTaskRecord } from "./task-registry.store.kernel.js";

const log = createSubsystemLogger("tasks/registry");
type Result = TaskInitialWorkerOperations[keyof TaskInitialWorkerOperations]["output"];

export function executeTaskInitialMutation(
  database: OpenClawStateDatabase,
  command: TaskInitialWorkerCommand,
): Result {
  let committed: { result: Result } | undefined;
  const accept = (result: Result) => {
    committed = { result };
  };
  const assertCurrent = () =>
    requestSqliteWorkerOperationAdmission({
      stage: "transaction",
      facts: {
        kind: "task-registry-mutation",
        operation: command.type,
        taskId: command.input.taskId,
      },
    });
  const write = <T>(operation: () => T): T =>
    runOpenClawStateWriteTransaction(operation, {
      database,
      path: database.path,
      env: getSqliteWorkerStateContext().environment,
    });
  try {
    return withSharedStateWriteCoordinator(
      { databasePath: database.path, existing: database.db, operationLabel: command.type },
      () => {
        if (command.type === "tasks.updateNotificationDelivery") {
          return updateTaskNotificationDeliveryInDatabase(database.db, command.input, write, {
            assertCurrent,
            onCommitted: accept,
          });
        }
        if (command.type === "tasks.acknowledgeStateChange") {
          return acknowledgeTaskStateNotificationInDatabase(database.db, command.input, write, {
            assertCurrent,
            onCommitted: accept,
          });
        }
        if (command.type === "tasks.createRecord") {
          return createTaskRecordInDatabase(database.db, command.input, write, {
            assertCurrent,
            retainTaskCommit(taskId) {
              const task = readTaskRecord(database.db, taskId);
              if (task?.runId) {
                deferSqliteWorkerCommitReceipt(
                  database.db,
                  captureTaskCreationEventTarget(task, command.type, command.input.taskId),
                );
              }
            },
            onCommitted(commit) {
              if (commit.kind === "task") {
                accept(commit.result);
              }
            },
          });
        }
        return write(() => {
          let result: Result;
          switch (command.type) {
            case "tasks.finalizeActive": {
              result = transitionTaskRecordInDatabase(
                database.db,
                { kind: "state", ...command.input },
                (operation) => operation(),
                { assertCurrent, onCommitted() {} },
              );
              break;
            }
            case "tasks.settleUnstarted": {
              const task = readTaskRecord(database.db, command.input.taskId);
              result =
                task &&
                (task.status === "queued" || task.status === "running") &&
                task.endedAt === undefined
                  ? transitionTaskRecordInDatabase(
                      database.db,
                      {
                        kind: "state",
                        taskId: command.input.taskId,
                        now: command.input.now,
                        expectedTask: command.input.expectedTask,
                        params: {
                          ...command.input.terminal,
                          runId: command.input.expectedTask.runId,
                          runtime: command.input.expectedTask.runtime,
                          sessionKey:
                            command.input.expectedTask.childSessionKey ??
                            command.input.expectedTask.ownerKey,
                        },
                      },
                      (operation) => operation(),
                      { assertCurrent, onCommitted() {} },
                    )
                  : null;
              break;
            }
            case "flows.createForTask":
              result = createInitialTaskFlowInDatabase(database.db, command.input, assertCurrent);
              break;
            case "tasks.linkInitialFlow":
              result = linkInitialTaskFlowInDatabase(database.db, command.input, assertCurrent);
              break;
            case "flows.deleteUnlinkedForTask":
              result = deleteUnlinkedInitialTaskFlowInDatabase(
                database.db,
                command.input,
                assertCurrent,
              );
              break;
            case "flows.finalizeTaskCancellation":
              result = finalizeInitialTaskManagedCancellationInDatabase(
                database.db,
                command.input,
                assertCurrent,
              );
              break;
          }
          deferSqlitePostCommitPublication(database.db, () => accept(result));
          return result;
        });
      },
    );
  } catch (error) {
    if (committed) {
      log.warn("Initial task mutation committed before cleanup failed", {
        operation: command.type,
        taskId: command.input.taskId,
        error,
      });
      return committed.result;
    }
    throw error;
  }
}
