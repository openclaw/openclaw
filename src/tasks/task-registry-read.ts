import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import {
  captureTaskRegistryReadFence,
  hasPendingTaskRegistryEvents,
  listPendingTaskRegistryEventTaskIds,
} from "./task-registry-listener-state.js";
import {
  cloneTaskRecord,
  compareTasksNewestFirst,
  listTasksFromIndex,
  selectTaskRecordsForOwnerTree,
  selectTaskRecordsWithAncestors,
} from "./task-registry-records.js";
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
  taskIdsInScope,
  type PendingTaskRegistryMutation,
} from "./task-registry.process-state.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";
import { taskMatchesRelatedSession } from "./task-session-identity.js";

export type TaskRegistryRead = {
  assertOwnerCurrent: () => void;
  assertCurrent: () => void;
  isTaskCurrent: (taskId: string) => boolean;
  isTaskSettled: (taskId: string) => boolean;
  isChildSessionCurrent: (childSessionKey: string) => boolean;
  hasPendingTasksForFlow: (flowId: string) => boolean;
  getTaskById: (taskId: string) => TaskRecord | undefined;
  getTasksByRunId: (runId: string) => TaskRecord[];
  listTaskRecordsForChildSessionKey: (childSessionKey: string) => TaskRecord[];
  listTaskRecordsForOwnerTree: (rootOwnerKeys: ReadonlySet<string>) => TaskRecord[];
  listTaskRecordsWithAncestors: (
    taskIds: readonly string[],
    isRootTask: (task: Readonly<TaskRecord>) => boolean,
  ) => TaskRecord[];
  listTasksForRelatedSessionKey: (sessionKey: string, sessionAgentId?: string) => TaskRecord[];
  listTasksForAgentId: (agentId: string) => TaskRecord[];
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

function isTaskRegistryReadCurrent(taskId: string, mode: "identity" | "settled"): boolean {
  const { projection } = getTaskRegistryProcessState();
  if (projection.pending.size === 0 && projection.dirtyScopes.size === 0) {
    return true;
  }
  const task = tasks.get(taskId);
  const currentScopes = new Set<TaskRegistryMutationScope>();
  for (const pending of projection.pending) {
    if (mode === "identity" && pending.readIdentity === "preserved") {
      currentScopes.add(pending.scope);
      continue;
    }
    const creation =
      mode === "identity" &&
      typeof pending.readIdentity === "object" &&
      pending.readIdentity.kind === "creation"
        ? pending.readIdentity
        : undefined;
    const changesIdentity = creation
      ? creation.taskId === taskId ||
        Boolean(
          creation.runId &&
          (task?.runId?.trim() === creation.runId ||
            pending.published.get(taskId)?.runId?.trim() === creation.runId),
        )
      : pending.scope.taskId === taskId ||
        pending.published.has(taskId) ||
        (task && matchesScope(task, pending.scope));
    if (changesIdentity || pending.publication?.records.has(taskId)) {
      return false;
    }
    if (creation) {
      // Its broad readback includes sibling session rows that creation cannot rewrite.
      currentScopes.add(pending.scope);
    }
  }
  // Failed publication can leave a dirty scope after its mutation owner retires.
  for (const scope of projection.dirtyScopes) {
    if (
      !currentScopes.has(scope) &&
      (scope.taskId === taskId || (task && matchesScope(task, scope)))
    ) {
      return false;
    }
  }
  return true;
}

type TaskRegistryReadOwner = {
  context: OpenClawStateWorkerContext;
  store: TaskRegistryStore;
  assertCurrent: () => void;
};

function canReadResidentTaskMetadata(): boolean {
  const { projection } = getTaskRegistryProcessState();
  if (projection.dirty || !hasPendingTaskRegistryEvents()) {
    return false;
  }
  const preserved = new Set<TaskRegistryMutationScope>();
  for (const pending of projection.pending) {
    if (pending.readIdentity !== "preserved") {
      return false;
    }
    preserved.add(pending.scope);
  }
  return [...projection.dirtyScopes].every((scope) => preserved.has(scope));
}

/** External readers join a fixed accepted prefix; persistence preparation must never use this fence. */
export async function prepareTaskRegistryReadOwner(
  context = captureOpenClawStateWorkerContext(),
  store = getTaskRegistryStore(),
  pendingMutations: readonly PendingTaskRegistryMutation[] = [],
): Promise<TaskRegistryReadOwner> {
  const fence = captureTaskRegistryReadFence(context.admission);
  const mutations = pendingMutations.flatMap((pending) => {
    const settlement = pending.readSettlement;
    return settlement?.store === store && settlement.databaseKey === context.admission.identity.key
      ? [settlement.promise]
      : [];
  });
  const settled = await Promise.allSettled([
    ensureTaskRegistryReadyAsync(context),
    fence,
    ...mutations,
  ]);
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, "Task read preparation failed", errors[0]);
  }
  const assertCurrent = () => assertTaskRegistryOwnerCurrent(context, store);
  assertCurrent();
  return { context, store, assertCurrent };
}

/** Page requests join their initial mutation cohort and accepted events while retries refresh rows. */
export function createTaskRegistryReadPreparation() {
  let owner: TaskRegistryReadOwner | undefined;
  return async (): Promise<TaskRegistryRead | undefined> => {
    if (owner) {
      const store = getTaskRegistryStore();
      assertTaskRegistryOwnerCurrent(owner.context, store);
      // A replacement store starts its own fence; an invalid database cannot be reopened here.
      if (store !== owner.store) {
        owner = undefined;
      }
    }
    if (!owner) {
      const context = captureOpenClawStateWorkerContext();
      owner = await prepareTaskRegistryReadOwner(context, getTaskRegistryStore(), [
        ...getTaskRegistryProcessState().projection.pending,
      ]);
    }
    return prepareTaskRegistryRead(owner);
  };
}

export async function prepareTaskRegistryRead(
  owner?: TaskRegistryReadOwner,
): Promise<TaskRegistryRead | undefined> {
  const {
    context,
    store,
    assertCurrent: assertOwnerCurrent,
  } = owner ?? (await prepareTaskRegistryReadOwner());
  assertOwnerCurrent();
  await ensureTaskRegistryReadyAsync(context);
  assertOwnerCurrent();
  // Later metadata preserves routing and access; its live owners still owe publication.
  if (
    !canReadResidentTaskMetadata() &&
    !(await prepareTaskRegistryProjectionAsync(context, store, 3))
  ) {
    return undefined;
  }
  const assertCurrent = () => {
    assertOwnerCurrent();
    if (getTaskRegistryProcessState().projection.dirty) {
      throw new Error("Task registry read projection is no longer ready");
    }
  };
  assertCurrent();
  const isTaskCurrent = (taskId: string) => {
    assertCurrent();
    return isTaskRegistryReadCurrent(taskId.trim(), "identity");
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
    assertOwnerCurrent,
    assertCurrent,
    isTaskCurrent,
    isTaskSettled(taskId) {
      assertCurrent();
      return !hasPendingTaskRegistryEvents(taskId) && isTaskRegistryReadCurrent(taskId, "settled");
    },
    isChildSessionCurrent(childSessionKey) {
      assertCurrent();
      return isTaskRegistryReadScopeCurrent("childSessionKey", childSessionKey.trim());
    },
    hasPendingTasksForFlow(flowId) {
      assertCurrent();
      const { projection, taskIdsByParentFlowId } = getTaskRegistryProcessState();
      const intersects = (
        scope: TaskRegistryMutationScope,
        pending?: PendingTaskRegistryMutation,
      ) => {
        const targetId = pending?.readEventTarget?.()?.taskId ?? scope.taskId;
        const records = [...new Set([...taskIdsInScope(scope), targetId])].flatMap((taskId) => {
          const task = tasks.get(taskId);
          return task ? [task] : [];
        });
        const facts = [
          ...records,
          ...[...(pending?.published.values() ?? [])].flatMap((task) => (task ? [task] : [])),
          ...(pending?.publication?.records.values() ?? []),
        ];
        if (scope.flowId === flowId || facts.some((task) => task.parentFlowId?.trim() === flowId)) {
          return true;
        }
        // A known target can belong to another flow or no flow. Only missing ownership is global.
        return !scope.flowId && !facts.some((task) => task.taskId === targetId);
      };
      const pendingScopes = new Set<TaskRegistryMutationScope>();
      for (const pending of projection.pending) {
        pendingScopes.add(pending.scope);
        if (intersects(pending.scope, pending)) {
          return true;
        }
      }
      for (const scope of projection.dirtyScopes) {
        if (!pendingScopes.has(scope) && intersects(scope)) {
          return true;
        }
      }
      for (const taskId of listPendingTaskRegistryEventTaskIds()) {
        const facts = [
          tasks.get(taskId),
          ...[...projection.pending].flatMap((pending) => [
            pending.published.get(taskId),
            pending.publication?.records.get(taskId),
          ]),
        ].filter((task) => task !== undefined);
        if (facts.length === 0 || facts.some((task) => task.parentFlowId?.trim() === flowId)) {
          return true;
        }
      }
      return [...(taskIdsByParentFlowId.get(flowId) ?? [])].some((taskId) => {
        const task = tasks.get(taskId);
        return task !== undefined && isTaskFlowCancellationPending(task);
      });
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
    listTaskRecordsWithAncestors(taskIds, isRootTask) {
      assertCurrent();
      return selectTaskRecordsWithAncestors(
        tasks,
        getTaskRegistryProcessState().taskIdsByChildSessionKey,
        taskIds,
        isRootTask,
      ).map((task) => {
        if (!isTaskCurrent(task.taskId)) {
          throw new Error("Task registry read identity requires preparation");
        }
        return cloneTaskRecord(task);
      });
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
    listTasksForRelatedSessionKey(sessionKey, sessionAgentId) {
      assertCurrent();
      const key = normalizeOptionalString(sessionKey);
      if (!key) {
        return [];
      }
      return listTasksFromIndex(tasks, taskIdsByRelatedSessionKey, key).filter((task) => {
        if (!isTaskCurrent(task.taskId)) {
          throw new Error("Task registry read identity requires preparation");
        }
        return taskMatchesRelatedSession(task, key, sessionAgentId);
      });
    },
    listTasksForAgentId(agentId) {
      assertCurrent();
      const lookup = agentId.trim();
      if (!lookup) {
        return [];
      }
      return [...tasks.values()]
        .filter((task) => task.agentId?.trim() === lookup)
        .map((task) => {
          if (!isTaskCurrent(task.taskId)) {
            throw new Error("Task registry read identity requires preparation");
          }
          return cloneTaskRecord(task);
        })
        .toSorted(compareTasksNewestFirst);
    },
  };
}
