// Persists task registry records through the global shared-state database owner.
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  bindTaskRunExecutionInDatabase,
  deleteTaskRowsWithDeliveryState,
  listTaskRecordsByOwnerKeyInDatabase,
  listTaskRecordsByRuntimeSourceIdInDatabase,
  readTaskRegistrySnapshot,
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshotIfReady,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
  type TaskRegistryDatabase,
  type TaskRegistryReadOnlyLoadResult,
} from "./task-registry.store.kernel.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord, TaskRuntime } from "./task-registry.types.js";

let cachedDatabase: TaskRegistryDatabase | null = null;

function openTaskRegistryDatabase(): TaskRegistryDatabase {
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

function withWriteTransaction(write: (database: OpenClawStateDatabase) => void) {
  // Open once before BEGIN; the callback receives that exact shared-state owner.
  openTaskRegistryDatabase();
  runOpenClawStateWriteTransaction((database) => write(database));
}

export function loadTaskRegistryStateFromSqlite(): TaskRegistryStoreSnapshot {
  return readTaskRegistrySnapshot(openTaskRegistryDatabase());
}

export function withTaskRegistrySqliteMutation<T>(operation: () => T): T {
  const database = openTaskRegistryDatabase();
  return withSharedStateWriteCoordinator(
    { databasePath: database.path, existing: database.db, operationLabel: "task.mutation" },
    operation,
  );
}

export function loadTaskRegistryMutationStateFromSqlite(
  scope: TaskRegistryMutationScope,
): TaskRegistryStoreSnapshot {
  return readTaskRegistryMutationSnapshotInDatabase(openTaskRegistryDatabase().db, scope);
}

/** Loads task records without creating or migrating shared state. */
export function loadTaskRegistryStateFromSqliteReadOnly(): TaskRegistryStoreSnapshot {
  return loadTaskRegistryStateFromSqliteReadOnlyResult().snapshot;
}

/** Reads task state only when the existing database already has the canonical task shape. */
export function loadTaskRegistryStateFromSqliteReadOnlyResult(): TaskRegistryReadOnlyLoadResult {
  return (
    withExistingOpenClawStateDatabaseReadOnly(readTaskRegistrySnapshotIfReady) ?? {
      state: "ready",
      snapshot: { tasks: new Map(), deliveryStates: new Map() },
    }
  );
}

export async function listTaskRegistryRecordsByOwnerKeyFromSqlite(
  ownerKey: string,
): Promise<TaskRecord[]> {
  const key = ownerKey.trim();
  if (!key) {
    return [];
  }
  const { db } = openTaskRegistryDatabase();
  return listTaskRecordsByOwnerKeyInDatabase(db, key);
}

/** Reads task rows for one runtime/source without restoring the process registry snapshot. */
export function listTaskRegistryRecordsByRuntimeSourceIdFromSqlite(params: {
  runtime: TaskRuntime;
  sourceId?: string;
}): TaskRecord[] {
  const sourceId = params.sourceId?.trim();
  if (params.sourceId !== undefined && !sourceId) {
    return [];
  }
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      listTaskRecordsByRuntimeSourceIdInDatabase(db, params.runtime, sourceId),
    ) ?? []
  );
}

/** Binds only the exact task row selected before admission; runId is never a join key. */
export function bindTaskRunExecution(params: {
  admitted: AdmittedRunContext;
  taskId: string;
  options?: OpenClawStateDatabaseOptions;
}): ExecutionOwnerBindingResult {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => bindTaskRunExecutionInDatabase(db, params.taskId, binding),
    params.options,
    { operationLabel: "task.run.execution-binding" },
  );
}

export function upsertTaskWithDeliveryStateToSqlite(params: {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}) {
  withWriteTransaction((database) => upsertTaskWithDeliveryStateInDatabase(database, params));
}

export function deleteTaskAndDeliveryStateFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskRowsWithDeliveryState(db, taskId);
  });
}

export function upsertTaskDeliveryStateToSqlite(state: TaskDeliveryState) {
  withWriteTransaction(({ db }) => upsertTaskDeliveryStateInDatabase(db, state));
}

export function closeTaskRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
