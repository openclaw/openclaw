// Persists task-flow records through the global shared-state database owner.
import type { DatabaseSync } from "node:sqlite";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TaskFlowSyncInput } from "./task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  deleteTaskFlowRowInDatabase,
  readTaskFlowRegistrySnapshot,
  syncTaskMirroredFlowRecordInDatabase,
  updateTaskFlowRecordInDatabase,
  upsertTaskFlowRowInDatabase,
} from "./task-flow-registry.store.kernel.js";
import type {
  TaskFlowRegistryMirroredSync,
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdatePublication,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

const log = createSubsystemLogger("tasks/task-flow-registry");

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

let cachedDatabase: FlowRegistryDatabase | null = null;

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const database = openOpenClawStateDatabase();
  const pathname = database.path;
  if (cachedDatabase && cachedDatabase.path === pathname && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }
  cachedDatabase = {
    db: database.db,
    path: pathname,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (database: FlowRegistryDatabase) => void) {
  const database = openFlowRegistryDatabase();
  runOpenClawStateWriteTransaction(() => {
    write(database);
  });
}

export function loadTaskFlowRegistryStateFromSqlite(
  flowIds?: readonly string[],
): TaskFlowRegistryStoreSnapshot {
  return readTaskFlowRegistrySnapshot(openFlowRegistryDatabase().db, flowIds);
}

/** Loads task flows without creating or migrating shared state. */
export function loadTaskFlowRegistryStateFromSqliteReadOnly(): TaskFlowRegistryStoreSnapshot {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => readTaskFlowRegistrySnapshot(db)) ?? {
      flows: new Map(),
    }
  );
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  withWriteTransaction(({ db }) => {
    upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(flow));
  });
}

export function syncTaskMirroredFlowInSqlite(
  task: TaskFlowSyncInput,
  preparePublication: (result: TaskFlowRegistryMirroredSync) => TaskFlowRegistryUpdatePublication,
): TaskFlowRegistryMirroredSync {
  let committed: TaskFlowRegistryMirroredSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const result = syncTaskMirroredFlowRecordInDatabase(db, task);
      const publication = preparePublication(result);
      stageSqliteTransactionState(db, {
        stage: publication.stage,
        rollback: publication.rollback,
        commit: () => {
          committed = result;
          publication.commit();
        },
      });
      return result;
    });
  } catch (error) {
    if (!committed) {
      throw error;
    }
    log.warn("Task-mirrored flow committed before cleanup failed", {
      taskId: task.taskId,
      flowId: task.parentFlowId,
      error,
    });
    return committed;
  }
}

export function updateTaskFlowRegistryRecordInSqlite(
  params: TaskFlowRegistryUpdate,
  preparePublication: (update: TaskFlowRegistryObservedUpdate) => TaskFlowRegistryUpdatePublication,
): TaskFlowRegistryUpdateResult {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = updateTaskFlowRecordInDatabase(db, params);
    if (result.applied || result.reason !== "invalid_patch") {
      const publication = preparePublication(result);
      stageSqliteTransactionState(db, {
        stage: publication.stage,
        rollback: publication.rollback,
        commit: publication.commit,
      });
    }
    return result;
  });
}

/** Binds only the exact flow selected before admission; lifecycle settlement stays owner-native. */
export async function bindTaskFlowExecution(params: {
  admitted: AdmittedRunContext;
  flowId: string;
  options?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<ExecutionOwnerBindingResult> {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  const context = params.context ?? captureOpenClawStateWorkerContext(params.options);
  const input = { flowId: params.flowId, binding };
  const assertOwnerCurrent = params.assertCurrent;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertOwnerCurrent?.();
  };
  const [{ runOpenClawStateWorkerOperation }, { createSqliteWorkerWriteAdmission }] =
    await Promise.all([
      import("../state/openclaw-state-worker-store.js"),
      import("../infra/sqlite-worker-store.js"),
    ]);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "flows.bindExecution", input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  withWriteTransaction(({ db }) => deleteTaskFlowRowInDatabase(db, flowId));
}

export function closeTaskFlowRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
