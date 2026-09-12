// Persists task-flow records through the global shared-state database owner.
import type { DatabaseSync } from "node:sqlite";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  bindTaskFlowExecutionInDatabase,
  bindTaskFlowRecord,
  deleteTaskFlowRowInDatabase,
  readTaskFlowRegistrySnapshot,
  updateTaskFlowRecordInDatabase,
  upsertTaskFlowRowInDatabase,
} from "./task-flow-registry.store.kernel.js";
import type {
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdatePublication,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

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

export function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot {
  return readTaskFlowRegistrySnapshot(openFlowRegistryDatabase().db);
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
      deferSqlitePostCommitPublication(db, publication.publish);
    }
    return result;
  });
}

/** Binds only the exact flow selected before admission; lifecycle settlement stays owner-native. */
export function bindTaskFlowExecution(params: {
  admitted: AdmittedRunContext;
  flowId: string;
  options?: OpenClawStateDatabaseOptions;
}): ExecutionOwnerBindingResult {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => bindTaskFlowExecutionInDatabase(db, params.flowId, binding),
    params.options,
    { operationLabel: "task.flow.execution-binding" },
  );
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  withWriteTransaction(({ db }) => deleteTaskFlowRowInDatabase(db, flowId));
}

export function closeTaskFlowRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
