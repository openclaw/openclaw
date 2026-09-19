import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { cloneTaskRecord, selectTaskRecordsForOwnerTree } from "./task-registry-records.js";
import {
  assertTaskRegistryOwnerCurrent,
  ensureTaskRegistryReadyAsync,
  prepareTaskRegistryProjectionAsync,
  tasks,
  taskIdsByOwnerKey,
  taskIdsByRelatedSessionKey,
} from "./task-registry-state.js";
import {
  getTaskRegistryProcessState,
  matchesScope,
  type PendingTaskRegistryMutation,
} from "./task-registry.process-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRegistryRead = {
  assertCurrent: () => void;
  isTaskCurrent: (taskId: string) => boolean;
  isChildSessionCurrent: (childSessionKey: string) => boolean;
  getTaskById: (taskId: string) => TaskRecord | undefined;
  getTasksByRunId: (runId: string) => TaskRecord[];
  listTaskRecordsForChildSessionKey: (childSessionKey: string) => TaskRecord[];
  listTaskRecordsForOwnerTree: (rootOwnerKeys: ReadonlySet<string>) => TaskRecord[];
};

function isTaskRegistryReadScopeCurrent(
  field: "runId" | "childSessionKey",
  value: string,
): boolean {
  const { projection } = getTaskRegistryProcessState();
  const observed = new Set<TaskRegistryMutationScope>();
  const intersects = (scope: TaskRegistryMutationScope, pending?: PendingTaskRegistryMutation) => {
    const facts = [
      tasks.get(scope.taskId),
      ...(pending?.published.values() ?? []),
      ...(pending?.publication?.records.values() ?? []),
      pending?.readEventTarget?.(),
    ];
    return (
      scope[field] === value ||
      facts.some((fact) => fact?.[field]?.trim() === value) ||
      (scope[field] === undefined && facts.every((fact) => !fact?.[field]))
    );
  };
  for (const pending of projection.pending) {
    observed.add(pending.scope);
    if (pending.readIdentity !== "preserved" && intersects(pending.scope, pending)) {
      return false;
    }
  }
  return [...projection.dirtyScopes].every((scope) => observed.has(scope) || !intersects(scope));
}

function isTaskRegistryReadIdentityCurrent(taskId: string): boolean {
  const { projection } = getTaskRegistryProcessState();
  if (projection.pending.size === 0 && projection.dirtyScopes.size === 0) {
    return true;
  }
  const task = tasks.get(taskId);
  const preserved = new Set<TaskRegistryMutationScope>();
  for (const pending of projection.pending) {
    if (pending.readIdentity === "preserved") {
      preserved.add(pending.scope);
    } else if (
      pending.scope.taskId === taskId ||
      pending.published.has(taskId) ||
      pending.publication?.records.has(taskId) ||
      (task && matchesScope(task, pending.scope))
    ) {
      return false;
    }
  }
  // Failed publication can leave a dirty scope after its mutation owner retires.
  for (const scope of projection.dirtyScopes) {
    if (!preserved.has(scope) && (scope.taskId === taskId || (task && matchesScope(task, scope)))) {
      return false;
    }
  }
  return true;
}

/** External readers join a fixed accepted prefix; persistence preparation must never use this fence. */
export async function prepareTaskRegistryRead(): Promise<TaskRegistryRead | undefined> {
  const context = captureOpenClawStateWorkerContext();
  const store = getTaskRegistryStore();
  const fence = captureTaskRegistryReadFence(context.admission);
  const settled = await Promise.allSettled([ensureTaskRegistryReadyAsync(context), fence]);
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, "Task read preparation failed", errors[0]);
  }
  assertTaskRegistryOwnerCurrent(context, store);
  if (!(await prepareTaskRegistryProjectionAsync(context, store, 3))) {
    return undefined;
  }
  const assertCurrent = () => {
    assertTaskRegistryOwnerCurrent(context, store);
    if (getTaskRegistryProcessState().projection.dirty) {
      throw new Error("Task registry read projection is no longer ready");
    }
  };
  assertCurrent();
  const isTaskCurrent = (taskId: string) => {
    assertCurrent();
    return isTaskRegistryReadIdentityCurrent(taskId.trim());
  };
  const readScope = (field: "runId" | "childSessionKey", value: string, ids: Iterable<string>) => {
    assertCurrent();
    if (!isTaskRegistryReadScopeCurrent(field, value)) {
      throw new Error("Task registry read candidate scope requires preparation");
    }
    return [...ids].flatMap((taskId) => {
      if (!isTaskCurrent(taskId)) {
        throw new Error("Task registry read identity requires preparation");
      }
      const task = tasks.get(taskId);
      return task ? [cloneTaskRecord(task)] : [];
    });
  };
  return {
    assertCurrent,
    isTaskCurrent,
    isChildSessionCurrent(childSessionKey) {
      assertCurrent();
      return isTaskRegistryReadScopeCurrent("childSessionKey", childSessionKey.trim());
    },
    getTaskById(taskId) {
      if (!isTaskCurrent(taskId)) {
        throw new Error("Task registry read identity requires preparation");
      }
      const task = tasks.get(taskId.trim());
      return task ? cloneTaskRecord(task) : undefined;
    },
    getTasksByRunId(runId) {
      const normalized = runId.trim();
      return readScope(
        "runId",
        normalized,
        getTaskRegistryProcessState().taskIdsByRunId.get(normalized) ?? [],
      );
    },
    listTaskRecordsForChildSessionKey(childSessionKey) {
      const normalized = childSessionKey.trim();
      return readScope(
        "childSessionKey",
        normalized,
        taskIdsByRelatedSessionKey.get(normalized) ?? [],
      );
    },
    listTaskRecordsForOwnerTree(rootOwnerKeys) {
      assertCurrent();
      const selected = selectTaskRecordsForOwnerTree(tasks, taskIdsByOwnerKey, rootOwnerKeys);
      return selected.map((task) => {
        if (!isTaskCurrent(task.taskId)) {
          throw new Error("Task registry read identity requires preparation");
        }
        return cloneTaskRecord(task);
      });
    },
  };
}
