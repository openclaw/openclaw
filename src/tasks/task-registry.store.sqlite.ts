// Persists task registry records through the global shared-state database owner.
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  listTaskRecordsByRuntimeSourceIdInDatabase,
  readTaskRegistrySnapshot,
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshotIfReady,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord, TaskRuntime } from "./task-registry.types.js";

function withWriteTransaction(write: (database: OpenClawStateDatabase) => void) {
  // Open once before BEGIN; the callback receives that exact shared-state owner.
  openOpenClawStateDatabase();
  runOpenClawStateWriteTransaction((database) => write(database));
}

export function loadTaskRegistryStateFromSqlite(): TaskRegistryStoreSnapshot {
  return readTaskRegistrySnapshot(openOpenClawStateDatabase());
}

export function withTaskRegistrySqliteMutation<T>(operation: () => T): T {
  const database = openOpenClawStateDatabase();
  return withSharedStateWriteCoordinator(
    { databasePath: database.path, existing: database.db, operationLabel: "task.mutation" },
    operation,
  );
}

/** A native compatibility caller joins already-granted worker writes before selecting rows. */
export function settleTaskRegistrySqliteWrites(join: (deadlineMs: number) => void): void {
  const deadlineMs = performance.now() + readSqliteBusyTimeout(openOpenClawStateDatabase().db);
  runOpenClawStateWriteTransaction(() => {}, undefined, { operationLabel: "task.event.settle" });
  join(deadlineMs);
}

export function loadTaskRegistryMutationStateFromSqlite(
  scopes: readonly TaskRegistryMutationScope[],
): TaskRegistryStoreSnapshot {
  return readTaskRegistryMutationSnapshotInDatabase(openOpenClawStateDatabase().db, scopes);
}

/** Loads task records without creating or migrating shared state. */
export function loadTaskRegistryStateFromSqliteReadOnly(): TaskRegistryStoreSnapshot {
  return (
    withExistingOpenClawStateDatabaseReadOnly(readTaskRegistrySnapshotIfReady) ?? {
      tasks: new Map(),
      deliveryStates: new Map(),
    }
  );
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
export async function bindTaskRunExecution(params: {
  admitted: AdmittedRunContext;
  taskId: string;
  options?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<ExecutionOwnerBindingResult> {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  const context = params.context ?? captureOpenClawStateWorkerContext(params.options);
  const input = { taskId: params.taskId, binding };
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
    (scope) => scope.execute({ type: "tasks.bindExecution", input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

export function upsertTaskWithDeliveryStateToSqlite(params: {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}) {
  withWriteTransaction((database) => upsertTaskWithDeliveryStateInDatabase(database, params));
}

export function upsertTaskDeliveryStateToSqlite(state: TaskDeliveryState) {
  withWriteTransaction(({ db }) => upsertTaskDeliveryStateInDatabase(db, state));
}

export function closeTaskRegistryDatabase() {
  closeOpenClawStateDatabase();
}
