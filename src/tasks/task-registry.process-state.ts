import type { Result } from "@openclaw/normalization-core/result";
// Tracks task process state transitions used to reconcile running work.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { TaskSummary } from "../../packages/gateway-protocol/src/schema/tasks.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { TaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import {
  getTaskRelatedSessionIndexKeys,
  filterTasksByRunScope,
  cloneTaskRecordForObserver,
  isEquivalentTaskRecord,
  listTasksFromIndex,
} from "./task-registry-records.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryObserverEvent,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord, TaskRuntime } from "./task-registry.types.js";

export type PendingTaskRegistryMutation = {
  scope: TaskRegistryMutationScope;
  readEventTarget?: () => TaskAgentEventTarget | undefined;
  readIdentity?: "preserved";
  published: Map<string, Omit<TaskRecord, "detail"> | undefined>;
  publication?: {
    records: Map<string, TaskRecord>;
    ready: Set<string>;
    invalidated: Set<string>;
  };
  readWitness?: { writtenTaskIds: Set<string>; replaced: boolean };
  recoveryWitness?: { writtenTaskIds: Set<string>; replaced: boolean };
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
  executionState?: "running" | "waiting" | "finished" | "unknown";
  executionWait?: NonNullable<TaskSummary["execution"]>["wait"];
  pendingApprovalIds: Set<string>;
  approvalObservationOverflow?: true;
  lastActivityAt?: number;
  currentTools: Map<string, { name: string; startedAt: number }>;
  preparedItems: Map<string, AgentActivityItem>;
  preparedGeneration?: number;
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

export type TaskProgressItem = {
  item: AgentActivityItem;
  source?: { taskId: string; runId: string; generation: number; label: string };
};
export type TaskProgressPlan = Pick<
  Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0],
  "steps" | "explanation" | "explanationFormat"
>;

export type TaskProgressMember = {
  runId: string;
  taskRunId: string;
  generation: number;
  childSessionKey: string;
  progressOrigin?: SubagentRunRecord["progressOrigin"];
};

export type TaskProgressBatch = {
  lifecycleGeneration: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterSessionId?: string;
  operationId?: string;
  origin: DeliveryContext;
  abortController: AbortController;
  lastPublishedContent?: string;
  typingStarted?: boolean;
  members: Map<string, TaskProgressMember>;
  pendingItems: Map<string, TaskProgressItem>;
  pendingPlan?: TaskProgressPlan;
  requesterContinuation?: {
    runId: string;
    requesterSessionId: string;
    isCurrent: () => boolean;
  };
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  publication?: Promise<void>;
};

export type TaskRegistryEventMutations = {
  prepare: () => { consume: () => void; release: () => void } | undefined;
  pending: () => boolean;
  captureReadFence: (admission: OpenClawStateDatabaseReadAdmission) => Promise<void>;
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
  listener?: {
    stop: (() => void) | null;
    events: TaskRegistryEventMutations;
  };
  changeListeners: Set<(event?: TaskRegistryObserverEvent) => void>;
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
    batch.abortController.abort();
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

export function getTasksByRunScope(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  return filterTasksByRunScope(getTasksByRunId(params.runId), params);
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

export function removeTaskIndexes(task: TaskRecord): void {
  deleteRunIdIndex(task.taskId, task.runId);
  deleteOwnerKeyIndex(task.taskId, task);
  deleteParentFlowIdIndex(task.taskId, task);
  deleteRelatedSessionKeyIndex(task.taskId, task);
}

export function addTaskIndexes(task: TaskRecord): void {
  addRunIdIndex(task.taskId, task.runId);
  addOwnerKeyIndex(task.taskId, task);
  addParentFlowIdIndex(task.taskId, task);
  addRelatedSessionKeyIndex(task.taskId, task);
}

export function taskIdsInScope(scope?: TaskRegistryMutationScope): Iterable<string> {
  if (!scope) {
    return indexState.tasks.keys();
  }
  return new Set([
    scope.taskId,
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

/** Restore transaction-local publication facts without replacing held witness objects. */
export function captureTaskRegistryPublicationRollback(): () => void {
  const captured = [...indexState.projection.pending].map((pending) => ({
    pending,
    published: new Map(pending.published),
    witnesses: [pending.readWitness, pending.recoveryWitness].flatMap((witness) =>
      witness
        ? [{ witness, writtenTaskIds: new Set(witness.writtenTaskIds), replaced: witness.replaced }]
        : [],
    ),
    publication: pending.publication && {
      owner: pending.publication,
      invalidated: new Set(pending.publication.invalidated),
    },
  }));
  return () => {
    for (const { pending, published, witnesses, publication } of captured) {
      pending.published.clear();
      for (const [taskId, task] of published) {
        pending.published.set(taskId, task);
      }
      for (const { witness, writtenTaskIds, replaced } of witnesses) {
        witness.writtenTaskIds.clear();
        for (const taskId of writtenTaskIds) {
          witness.writtenTaskIds.add(taskId);
        }
        witness.replaced = replaced;
      }
      if (publication) {
        publication.owner.invalidated.clear();
        for (const taskId of publication.invalidated) {
          publication.owner.invalidated.add(taskId);
        }
      }
    }
  };
}

/** A committed projection write supersedes held reads even when its value returns to the original. */
export function recordTaskRegistryProjectionWrite(
  source: "task" | "snapshot" | "refresh" | "delivery" | ReadonlyMap<string, TaskRecord>,
  taskId?: string,
  deleted = false,
): void {
  // A writer's readback can refresh peers outside its committed receipt.
  const kind =
    typeof source === "string"
      ? source
      : taskId !== undefined && source.has(taskId)
        ? "snapshot"
        : "refresh";
  for (const pending of indexState.projection.pending) {
    const recovery = pending.recoveryWitness;
    if (recovery && kind !== "delivery" && kind !== "refresh") {
      if (taskId === undefined) {
        recovery.replaced = true;
      } else if (taskId === pending.scope.taskId) {
        recovery.writtenTaskIds.add(taskId);
      }
    }
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
    if (!publication || kind === "delivery") {
      continue;
    }
    for (const id of taskId === undefined ? publication.records.keys() : [taskId]) {
      // A predecessor's snapshot cannot supersede a receipt still waiting for its own read.
      const expected = publication.records.get(id);
      if (
        !expected ||
        ((kind === "snapshot" || kind === "refresh") && !witness && !publication.ready.has(id))
      ) {
        continue;
      }
      const current = deleted ? undefined : indexState.tasks.get(id);
      if (current === undefined || !isEquivalentTaskRecord(expected, current)) {
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
