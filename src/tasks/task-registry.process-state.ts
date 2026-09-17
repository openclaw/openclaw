import type { Result } from "@openclaw/normalization-core/result";
// Tracks task process state transitions used to reconcile running work.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { TaskSummary } from "../../packages/gateway-protocol/src/schema/tasks.js";
import {
  getTaskRelatedSessionIndexKeys,
  cloneTaskRecordForObserver,
  isEquivalentTaskRecord,
  listTasksFromIndex,
} from "./task-registry-records.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryObserverEvent,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type PendingTaskRegistryMutation = {
  scope: TaskRegistryMutationScope;
  published: Map<string, Omit<TaskRecord, "detail"> | undefined>;
  publication?: {
    records: Map<string, TaskRecord | undefined>;
    ready: Set<string>;
    invalidated: Set<string>;
  };
  readWitness?: { writtenTaskIds: Set<string>; replaced: boolean };
};

export type TaskRunOwner = {
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskActivityOverlayState = {
  runId: string;
  executionRunId?: string;
  executionId?: string;
  executionSourceId?: string;
  executionState?: "running" | "waiting" | "unknown";
  executionWait?: NonNullable<TaskSummary["execution"]>["wait"];
  pendingApprovalIds: Set<string>;
  approvalObservationOverflow?: true;
  lastActivityAt?: number;
  currentTools: Map<string, { name: string; startedAt: number }>;
  assistantText: string;
  thinkingText: string;
  hasAssistantActivity: boolean;
  lastActivity?: string;
  files: Set<string>;
  added: number;
  removed: number;
  pendingDiffByToolCallId: Map<string, { files: string[]; added: number; removed: number }>;
  dirty: boolean;
  lastFlushedAt?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
};

export type TaskProgressBatch = {
  lifecycleGeneration: string;
  members: Map<string, { runId: string; generation: number }>;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  publishing?: boolean;
  overflow: boolean;
};

/** Process-local indexes backing task lookup, owner access, and pending delivery scans. */
type TaskRegistryProcessState = {
  tasks: Map<string, TaskRecord>;
  taskDeliveryStates: Map<string, TaskDeliveryState>;
  taskIdsByRunId: Map<string, Set<string>>;
  taskIdsByOwnerKey: Map<string, Set<string>>;
  taskIdsByParentFlowId: Map<string, Set<string>>;
  taskIdsByRelatedSessionKey: Map<string, Set<string>>;
  tasksWithPendingDelivery: Set<string>;
  /** Ephemeral live activity is intentionally discarded on gateway restart. */
  taskActivityByTaskId: Map<string, TaskActivityOverlayState>;
  /** Bounded presentation work; completion and restart recovery never depend on it. */
  taskProgressBatches: Map<string, TaskProgressBatch>;
  /** Live owners survive store reloads, but are never persisted or restored after restart. */
  runOwners: Map<string, TaskRunOwner>;
  // Listener ownership must survive module reloads alongside the task indexes it updates.
  listenerStop?: (() => void) | null;
  changeListeners: Set<() => void>;
  projection: {
    epoch: number;
    dirty: boolean;
    mutationDepth: number;
    pending: Set<PendingTaskRegistryMutation>;
    readTail?: Promise<void>;
    dirtyScopes: Set<TaskRegistryMutationScope>;
  };
};

const TASK_REGISTRY_PROCESS_STATE_KEY = Symbol.for("openclaw.taskRegistry.state");

/** Returns the singleton in-process task registry state. */
export function getTaskRegistryProcessState(): TaskRegistryProcessState {
  const globalState = globalThis as typeof globalThis & {
    [TASK_REGISTRY_PROCESS_STATE_KEY]?: TaskRegistryProcessState;
  };
  globalState[TASK_REGISTRY_PROCESS_STATE_KEY] ??= {
    tasks: new Map<string, TaskRecord>(),
    taskDeliveryStates: new Map<string, TaskDeliveryState>(),
    taskIdsByRunId: new Map<string, Set<string>>(),
    taskIdsByOwnerKey: new Map<string, Set<string>>(),
    taskIdsByParentFlowId: new Map<string, Set<string>>(),
    taskIdsByRelatedSessionKey: new Map<string, Set<string>>(),
    tasksWithPendingDelivery: new Set<string>(),
    taskActivityByTaskId: new Map<string, TaskActivityOverlayState>(),
    taskProgressBatches: new Map<string, TaskProgressBatch>(),
    runOwners: new Map<string, TaskRunOwner>(),
    changeListeners: new Set(),
    projection: {
      epoch: 0,
      dirty: false,
      mutationDepth: 0,
      pending: new Set(),
      dirtyScopes: new Set(),
    },
  };
  return globalState[TASK_REGISTRY_PROCESS_STATE_KEY];
}

export function clearTaskProgressBatches(): void {
  const batches = getTaskRegistryProcessState().taskProgressBatches;
  for (const batch of batches.values()) {
    clearTimeout(batch.timer);
  }
  batches.clear();
}

const indexState = getTaskRegistryProcessState();

export function getTasksByRunId(runId: string): TaskRecord[] {
  const ids = indexState.taskIdsByRunId.get(runId.trim());
  if (!ids || ids.size === 0) {
    return [];
  }
  return [...ids]
    .map((taskId) => indexState.tasks.get(taskId))
    .filter((task): task is TaskRecord => Boolean(task));
}

export function addRunIdIndex(taskId: string, runId?: string) {
  const trimmed = runId?.trim();
  if (!trimmed) {
    return;
  }
  let ids = indexState.taskIdsByRunId.get(trimmed);
  if (!ids) {
    ids = new Set<string>();
    indexState.taskIdsByRunId.set(trimmed, ids);
  }
  ids.add(taskId);
}

export function deleteRunIdIndex(taskId: string, runId?: string): void {
  if (runId?.trim()) {
    deleteIndexedKey(indexState.taskIdsByRunId, runId.trim(), taskId);
  }
}

function addIndexedKey(index: Map<string, Set<string>>, key: string, taskId: string) {
  let ids = index.get(key);
  if (!ids) {
    ids = new Set<string>();
    index.set(key, ids);
  }
  ids.add(taskId);
}

function deleteIndexedKey(index: Map<string, Set<string>>, key: string, taskId: string) {
  const ids = index.get(key);
  if (!ids) {
    return;
  }
  ids.delete(taskId);
  if (ids.size === 0) {
    index.delete(key);
  }
}

type TaskSessionKeys = Pick<TaskRecord, "requesterSessionKey" | "ownerKey" | "childSessionKey">;

export function addOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  addIndexedKey(indexState.taskIdsByOwnerKey, key, taskId);
}

export function deleteOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  deleteIndexedKey(indexState.taskIdsByOwnerKey, key, taskId);
}

export function addParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  addIndexedKey(indexState.taskIdsByParentFlowId, key, taskId);
}

export function deleteParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  deleteIndexedKey(indexState.taskIdsByParentFlowId, key, taskId);
}

export function addRelatedSessionKeyIndex(taskId: string, task: TaskSessionKeys) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    addIndexedKey(indexState.taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

export function deleteRelatedSessionKeyIndex(taskId: string, task: TaskSessionKeys) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    deleteIndexedKey(indexState.taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

export function rebuildRunIdIndex() {
  indexState.taskIdsByRunId.clear();
  for (const [taskId, task] of indexState.tasks.entries()) {
    addRunIdIndex(taskId, task.runId);
  }
}

export function taskIdsInScope(scope?: TaskRegistryMutationScope): Iterable<string> {
  if (!scope) {
    return indexState.tasks.keys();
  }
  return new Set([
    ...(scope.taskId ? [scope.taskId] : []),
    ...(scope.runId ? (indexState.taskIdsByRunId.get(scope.runId) ?? []) : []),
    ...(scope.childSessionKey
      ? (indexState.taskIdsByRelatedSessionKey.get(scope.childSessionKey) ?? [])
      : []),
  ]);
}

export function matchesScope(task: TaskRecord, scope: TaskRegistryMutationScope): boolean {
  return (
    task.taskId === scope.taskId ||
    Boolean(scope.runId && task.runId?.trim() === scope.runId) ||
    Boolean(scope.childSessionKey && task.childSessionKey?.trim() === scope.childSessionKey)
  );
}

/** A committed projection write supersedes held reads even when its value returns to the original. */
export function recordTaskRegistryProjectionWrite(
  source: "task" | "snapshot" | "delivery",
  taskId?: string,
  deleted = false,
): void {
  for (const pending of indexState.projection.pending) {
    const witness = pending.readWitness;
    if (witness) {
      const current = taskId === undefined ? undefined : indexState.tasks.get(taskId);
      if (taskId === undefined) {
        witness.replaced = true;
      } else if (
        taskId === pending.scope.taskId ||
        pending.published.has(taskId) ||
        (current && matchesScope(current, pending.scope))
      ) {
        witness.writtenTaskIds.add(taskId);
      }
    }
    const publication = pending.publication;
    if (!publication || source === "delivery") {
      continue;
    }
    for (const id of taskId === undefined ? publication.records.keys() : [taskId]) {
      // A predecessor's snapshot cannot supersede a receipt still waiting for its own read.
      if (
        !publication.records.has(id) ||
        (source === "snapshot" && !witness && !publication.ready.has(id))
      ) {
        continue;
      }
      const expected = publication.records.get(id);
      const current = deleted ? undefined : indexState.tasks.get(id);
      if (
        expected === undefined
          ? current !== undefined
          : current === undefined || !isEquivalentTaskRecord(expected, current)
      ) {
        publication.invalidated.add(id);
      }
    }
  }
}

export function recordTaskRegistryPublication(event: TaskRegistryObserverEvent): void {
  for (const pending of indexState.projection.pending) {
    if (event.kind === "restored") {
      for (const task of indexState.tasks.values()) {
        if (matchesScope(task, pending.scope)) {
          pending.published.set(task.taskId, cloneTaskRecordForObserver(task));
        }
      }
    } else {
      const task = event.kind === "upserted" ? event.task : event.previous;
      if (pending.published.has(task.taskId) || matchesScope(task, pending.scope)) {
        pending.published.set(
          task.taskId,
          event.kind === "upserted" ? cloneTaskRecordForObserver(event.task) : undefined,
        );
      }
    }
  }
}

export function selectLiveTaskFlowForSync(taskId: string) {
  const current = indexState.tasks.get(taskId);
  const flowId = current?.parentFlowId?.trim();
  return current &&
    flowId &&
    listTasksFromIndex(indexState.tasks, indexState.taskIdsByParentFlowId, flowId)[0]?.taskId ===
      taskId
    ? { taskId, flowId, createdAt: current.createdAt }
    : undefined;
}
