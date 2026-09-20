import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { filterCurrentTaskRunBackings } from "./task-backing-records.js";
import { getTaskMirroredFlowIds } from "./task-flow-runtime-internal.js";
import { clearTaskActivity } from "./task-registry-activity.js";
import { isActiveTaskStatus } from "./task-registry-common.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-flow-link.js";
import { clearTaskFlowSyncRetries } from "./task-registry-flow-sync.js";
import { resetTaskRegistryListenerState } from "./task-registry-listener-state.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import {
  cloneTaskRecord,
  listTasksFromIndex,
  cloneTaskRecordForObserver,
  normalizeTaskTimestamps,
  compareTasksNewestFirst,
  pickPreferredRunIdTask,
  snapshotTaskRecords,
  selectTaskRecordsForOwnerTree,
} from "./task-registry-records.js";
import {
  TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY,
  TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY,
  controlRuntimeLoader,
  deliveryRuntimeLoader,
  type TaskRegistryDeliveryRuntime,
  type TaskRegistryGlobalWithRuntimeOverrides,
} from "./task-registry-runtime-loaders.js";
import {
  withTaskRegistryMutation,
  bumpTaskRegistryRevision,
  clearTaskRegistryMemory,
  emitTaskRegistryObserverEvent,
  ensureTaskRegistryReady,
  getTasksByRunId,
  taskRegistryLog,
  readTaskRegistryRevision,
  resetTaskRegistryRestoreState,
  taskDeliveryStates,
  taskIdsByOwnerKey,
  taskIdsByParentFlowId,
  taskIdsByRelatedSessionKey,
  tasks,
} from "./task-registry-state.js";
import {
  deleteOwnerKeyIndex,
  deleteParentFlowIdIndex,
  deleteRelatedSessionKeyIndex,
  rebuildRunIdIndex,
  recordTaskRegistryProjectionWrite,
  getTaskRegistryProcessState,
} from "./task-registry.process-state.js";
import {
  tryPersistTaskDelete,
  getTaskRegistryStore,
  resetTaskRegistryRuntimeForTests,
} from "./task-registry.store.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";

export function listTaskRecordsUnsorted(): TaskRecord[] {
  ensureTaskRegistryReady();
  return snapshotTaskRecords(tasks);
}

/** Coarse tree candidates; callers still enforce agent identity and current control authority. */
export function listTaskRecordsForOwnerTree(rootOwnerKeys: ReadonlySet<string>): TaskRecord[] {
  ensureTaskRegistryReady();
  return selectTaskRecordsForOwnerTree(tasks, taskIdsByOwnerKey, rootOwnerKeys).map((task) =>
    cloneTaskRecord(task),
  );
}

function taskMatchesRelatedSession(
  task: TaskRecord,
  sessionKey: string | undefined,
  sessionAgentId?: string,
  cfg?: OpenClawConfig,
): boolean {
  if (!sessionKey) {
    return true;
  }
  return [
    { key: task.requesterSessionKey, agentId: task.requesterAgentId },
    { key: task.childSessionKey, agentId: task.agentId },
    // ownerKey belongs to the requester. task.agentId is the executor/child
    // candidate and must never adopt a colliding bare requester session.
    { key: task.ownerKey, agentId: task.requesterAgentId },
  ].some((candidate) => {
    if (normalizeOptionalString(candidate.key) !== sessionKey) {
      return false;
    }
    if (!sessionAgentId) {
      return true;
    }
    return resolveTaskSessionAgentId(candidate.key, candidate.agentId, cfg) === sessionAgentId;
  });
}

function taskMatchesAgent(
  task: TaskRecord,
  agentId: string | undefined,
  cfg?: OpenClawConfig,
): boolean {
  if (!agentId) {
    return true;
  }
  const knownAgentId =
    normalizeOptionalString(task.agentId) ?? normalizeOptionalString(task.requesterAgentId);
  if (knownAgentId) {
    return knownAgentId === agentId;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => resolveTaskSessionAgentId(candidate, undefined, cfg) === agentId,
  );
}

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function compareTaskPageOrder(
  left: TaskRecord,
  right: TaskRecord,
  sortBy: "updatedAt" | "endedAt",
): number {
  const leftAt = sortBy === "endedAt" ? (left.endedAt ?? -1) : taskUpdatedAt(left);
  const rightAt = sortBy === "endedAt" ? (right.endedAt ?? -1) : taskUpdatedAt(right);
  if (leftAt !== rightAt) {
    return rightAt - leftAt;
  }
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
}

function siftWorstTaskDown(
  heap: TaskRecord[],
  startIndex: number,
  compare: (left: TaskRecord, right: TaskRecord) => number,
): void {
  let index = startIndex;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) {
      return;
    }
    const left = heap[leftIndex];
    const current = heap[index];
    if (!left || !current) {
      return;
    }
    const rightIndex = leftIndex + 1;
    let worstIndex = leftIndex;
    const right = heap[rightIndex];
    if (right && compare(right, left) > 0) {
      worstIndex = rightIndex;
    }
    const worst = heap[worstIndex];
    if (!worst || compare(worst, current) <= 0) {
      return;
    }
    heap[index] = worst;
    heap[worstIndex] = current;
    index = worstIndex;
  }
}

function heapifyWorstTaskFirst(
  heap: TaskRecord[],
  compare: (left: TaskRecord, right: TaskRecord) => number,
): void {
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) {
    siftWorstTaskDown(heap, index, compare);
  }
}

const TASK_PAGE_MAX_ATTEMPTS = 3;
const TASK_PAGE_YIELD_INTERVAL_MS = 12;

export async function listTaskRecordPage(params: {
  offset: number;
  limit: number;
  expectedRevision?: number;
  statuses?: readonly TaskStatus[];
  agentId?: string;
  sessionKey?: string;
  sessionAgentId?: string;
  cfg?: OpenClawConfig;
  prepareFilter?: (
    tasks: readonly Readonly<TaskRecord>[],
  ) => (task: Readonly<TaskRecord>) => boolean;
  sortBy?: "updatedAt" | "endedAt";
}): Promise<
  Result<
    { tasks: TaskRecord[]; hasMore: boolean; revision: number; isCurrent: () => boolean },
    "cursor_stale" | "registry_changed"
  >
> {
  let read = await prepareTaskRegistryRead();
  if (!read) {
    return err("registry_changed");
  }
  const statuses = params.statuses ? new Set(params.statuses) : null;
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const compare = (left: TaskRecord, right: TaskRecord) =>
    compareTaskPageOrder(left, right, params.sortBy ?? "updatedAt");
  // Filtering and ordering stay registry-owned so authoritative records never
  // cross the boundary; only the bounded selected page is defensively cloned.
  const windowSize = params.offset + params.limit;
  let workStartedAt = performance.now();
  for (let attempt = 0; attempt < TASK_PAGE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      read = await prepareTaskRegistryRead();
      if (!read) {
        return err("registry_changed");
      }
    }
    const revision = readTaskRegistryRevision();
    if (params.expectedRevision !== undefined && params.expectedRevision !== revision) {
      return err("cursor_stale");
    }
    // Session pages scan only related candidates; exact owner/agent checks still run below.
    const source = sessionKey ? taskIdsByRelatedSessionKey.get(sessionKey) : tasks;
    const scanLimit = source?.size ?? 0;
    const window: TaskRecord[] = [];
    let matchingCount = 0;
    let heapReady = false;
    let scannedCount = 0;
    const iterator = source?.keys() ?? [].values();
    let current = iterator.next();
    while (!current.done && scannedCount < scanLimit) {
      // Cheap pages finish atomically even while other sessions are busy. Expensive
      // scans share the event loop without charging time queued behind other work.
      if (scannedCount > 0 && performance.now() - workStartedAt >= TASK_PAGE_YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        workStartedAt = performance.now();
        // A carried revision cannot recover; skip unrelated reads once it is stale.
        // Cursorless scans still finish their attempt before retrying.
        if (params.expectedRevision !== undefined && revision !== readTaskRegistryRevision()) {
          return err("cursor_stale");
        }
        if (revision === readTaskRegistryRevision()) {
          read.assertCurrent();
        }
      }
      const batch: TaskRecord[] = [];
      // A registry reload can leave this iterator with IDs whose records no longer exist.
      const batchEnd = Math.min(scannedCount + 32, scanLimit);
      while (!current.done && scannedCount < batchEnd) {
        const task = tasks.get(current.value);
        if (task) {
          batch.push(task);
        }
        scannedCount += 1;
        current = iterator.next();
      }
      if (revision === readTaskRegistryRevision()) {
        for (const task of batch) {
          if (!read.isTaskCurrent(task.taskId)) {
            return err("registry_changed");
          }
        }
      }
      const candidates = batch.filter(
        (task) =>
          (!statuses || statuses.has(task.status)) &&
          taskMatchesAgent(task, agentId, params.cfg) &&
          taskMatchesRelatedSession(task, sessionKey, params.sessionAgentId, params.cfg),
      );
      // Prepared metadata belongs to this synchronous slice, never the next await.
      const filter = params.prepareFilter?.(candidates);
      for (const task of candidates) {
        if (filter && !filter(task)) {
          continue;
        }
        matchingCount += 1;
        if (windowSize <= 0) {
          continue;
        }
        if (window.length < windowSize) {
          window.push(task);
          continue;
        }
        if (!heapReady) {
          heapifyWorstTaskFirst(window, compare);
          heapReady = true;
        }
        const cutoff = window[0];
        if (cutoff && compare(task, cutoff) < 0) {
          window[0] = task;
          siftWorstTaskDown(window, 0, compare);
        }
      }
    }
    if (revision !== readTaskRegistryRevision()) {
      if (params.expectedRevision !== undefined) {
        return err("cursor_stale");
      }
      continue;
    }
    read.assertCurrent();
    const selected =
      params.offset >= matchingCount ? [] : window.toSorted(compare).slice(params.offset);
    for (const task of selected) {
      if (!read.isTaskCurrent(task.taskId)) {
        return err("registry_changed");
      }
    }
    const prepared = read;
    return ok({
      tasks: selected.map((task) => cloneTaskRecord(task)),
      hasMore: params.offset + selected.length < matchingCount,
      revision,
      isCurrent: () => {
        if (revision !== readTaskRegistryRevision()) {
          return false;
        }
        // A held page can lose its owner after selection but before the response frame.
        try {
          prepared.assertCurrent();
          return selected.every(
            (task) => tasks.get(task.taskId) === task && prepared.isTaskCurrent(task.taskId),
          );
        } catch {
          return false;
        }
      },
    });
  }
  return err("registry_changed");
}

export function listTaskRecords(filter?: (task: Readonly<TaskRecord>) => boolean): TaskRecord[] {
  ensureTaskRegistryReady();
  const records = [...tasks.values()];
  return (filter ? records.filter(filter) : records)
    .map((task, insertionIndex) => Object.assign({}, cloneTaskRecord(task), { insertionIndex }))
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _insertionIndex, ...task }) => task);
}

export function hasActiveTaskForChildSessionKey(params: {
  sessionKey: string;
  agentId?: string;
  excludeTaskId?: string;
}): boolean {
  ensureTaskRegistryReady();
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const ids = taskIdsByRelatedSessionKey.get(sessionKey);
  if (!ids) {
    return false;
  }
  for (const taskId of ids) {
    if (taskId === params.excludeTaskId) {
      continue;
    }
    const task = tasks.get(taskId);
    if (
      task &&
      isActiveTaskStatus(task.status) &&
      normalizeOptionalString(task.childSessionKey) === sessionKey &&
      (!params.agentId ||
        resolveTaskSessionAgentId(task.childSessionKey, task.agentId) === params.agentId)
    ) {
      return true;
    }
  }
  return false;
}

export function getTaskById(taskId: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = tasks.get(taskId.trim());
  return task ? cloneTaskRecord(task) : undefined;
}

export function findTaskByRunId(runId: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const matches = getTasksByRunId(runId);
  let mirroredFlowIds: ReadonlySet<string> | undefined;
  const task = pickPreferredRunIdTask(
    filterCurrentTaskRunBackings(matches, (flowId) => {
      // Admit flows only when a candidate needs them, once for this synchronous lookup.
      mirroredFlowIds ??= getTaskMirroredFlowIds(
        matches.flatMap((candidate) =>
          candidate.parentFlowId ? [candidate.parentFlowId.trim()] : [],
        ),
      );
      return mirroredFlowIds.has(flowId);
    }),
  );
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForAgentId(agentId: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const lookup = agentId.trim();
  if (!lookup) {
    return [];
  }
  return [...tasks.values()]
    .filter((task) => task.agentId?.trim() === lookup)
    .map((task) => cloneTaskRecord(task))
    .toSorted(compareTasksNewestFirst);
}

export function listTasksForOwnerKey(ownerKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(ownerKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(tasks, taskIdsByOwnerKey, key);
}

export async function listFreshTasksForOwnerKey(ownerKey: string): Promise<TaskRecord[]> {
  const key = normalizeOptionalString(ownerKey);
  if (!key) {
    return [];
  }
  const read = await prepareTaskRegistryRead();
  if (!read) {
    throw new Error("Task activity did not stabilize. Retry the owner lookup.");
  }
  const store = getTaskRegistryStore();
  if (store.listTasksForOwnerKey) {
    try {
      const merged = new Map<string, TaskRecord>();
      const records = await store.listTasksForOwnerKey(key);
      read.assertCurrent();
      for (const task of records) {
        merged.set(task.taskId, cloneTaskRecord(normalizeTaskTimestamps(task)));
      }
      return [...merged.values()]
        .map((task, insertionIndex) => Object.assign({}, task, { insertionIndex }))
        .toSorted(compareTasksNewestFirst)
        .map(({ insertionIndex: _insertionIndex, ...task }) => task);
    } catch (error) {
      read.assertCurrent();
      taskRegistryLog.warn("Failed to read fresh owner task registry records", {
        ownerKey: key,
        error,
      });
    }
  }
  read.assertCurrent();
  return listTasksFromIndex(tasks, taskIdsByOwnerKey, key);
}

export function listTasksForFlowId(flowId: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = flowId.trim();
  if (!key) {
    return [];
  }
  return listTasksFromIndex(tasks, taskIdsByParentFlowId, key);
}

type TaskFlowTaskState = Pick<TaskRecord, "taskId" | "runtime" | "status" | "error">;

/** Snapshot linked task states in one read without cloning retained task payloads. */
export function listTaskStatesForFlowIds(
  flowIds: Iterable<string>,
): Map<string, TaskFlowTaskState[]> {
  ensureTaskRegistryReady();
  const states = new Map<string, TaskFlowTaskState[]>();
  for (const flowId of flowIds) {
    const key = flowId.trim();
    if (!key || states.has(key)) {
      continue;
    }
    const linked: TaskFlowTaskState[] = [];
    for (const taskId of taskIdsByParentFlowId.get(key) ?? []) {
      const task = tasks.get(taskId);
      if (task) {
        linked.push({
          taskId: task.taskId,
          runtime: task.runtime,
          status: task.status,
          error: task.error,
        });
      }
    }
    states.set(key, linked);
  }
  return states;
}

function findLatestTaskForRelatedSessionKey(sessionKey: string): TaskRecord | undefined {
  const task = listTasksForRelatedSessionKey(sessionKey)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForRelatedSessionKey(
  sessionKey: string,
  sessionAgentId?: string,
): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(tasks, taskIdsByRelatedSessionKey, key).filter((task) =>
    taskMatchesRelatedSession(task, key, sessionAgentId),
  );
}

export function resolveTaskForLookupToken(token: string): TaskRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return (
    getTaskById(lookup) ?? findTaskByRunId(lookup) ?? findLatestTaskForRelatedSessionKey(lookup)
  );
}

export function deleteTaskRecordById(taskId: string): boolean {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      const current = tasks.get(taskId);
      if (!current) {
        return false;
      }
      ensureLinkedTaskFlowRegistryReady(current);
      // Persist the delete before mutating memory, as a single atomic store
      // operation. If persistence fails, leave the in-memory record intact and
      // report that no delete was applied.
      if (!tryPersistTaskDelete(taskId)) {
        return false;
      }
      deleteOwnerKeyIndex(taskId, current);
      deleteParentFlowIdIndex(taskId, current);
      deleteRelatedSessionKeyIndex(taskId, current);
      clearTaskActivity(taskId);
      recordTaskRegistryProjectionWrite("task", taskId, true);
      tasks.delete(taskId);
      bumpTaskRegistryRevision();
      taskDeliveryStates.delete(taskId);
      rebuildRunIdIndex();
      emitTaskRegistryObserverEvent(() => ({
        kind: "deleted",
        taskId: current.taskId,
        previous: cloneTaskRecordForObserver(current),
      }));
      return true;
    },
    () => false,
  );
}

export function resetTaskRegistryForTests() {
  clearTaskFlowSyncRetries();
  getTaskRegistryProcessState().runOwners.clear();
  clearTaskRegistryMemory();
  resetTaskRegistryRestoreState();
  resetTaskRegistryRuntimeForTests();
  resetTaskRegistryListenerState();
  deliveryRuntimeLoader.clear();
  controlRuntimeLoader.clear();
  // Close the default SQLite handle too, even when a custom store was configured.
  getTaskRegistryStore().close?.();
}

export function resetTaskRegistryDeliveryRuntimeForTests() {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ] = null;
  deliveryRuntimeLoader.clear();
}

export function setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ] = runtime;
  deliveryRuntimeLoader.clear();
}

export function resetTaskRegistryControlRuntimeForTests() {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY
  ] = null;
  controlRuntimeLoader.clear();
}

export function setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY
  ] = runtime;
  controlRuntimeLoader.clear();
}
