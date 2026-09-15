import type { Result } from "@openclaw/normalization-core/result";
// Tracks task process state transitions used to reconcile running work.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { TaskSummary } from "../../packages/gateway-protocol/src/schema/tasks.js";
import { getTaskRelatedSessionIndexKeys } from "./task-registry-records.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type PendingTaskRegistryMutation = {
  scope: TaskRegistryMutationScope;
  published: Map<string, Omit<TaskRecord, "detail"> | undefined>;
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
