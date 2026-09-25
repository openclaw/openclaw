import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import {
  ensureDeliveryStatus,
  ensureNotifyPolicy,
  normalizeTaskStatus,
  normalizeTaskSummary,
  resolveTaskOwnerKey,
  resolveTaskRequesterSessionKey,
  resolveTaskScopeKind,
  resolveTaskTerminalOutcome,
} from "./task-registry-common.js";
import {
  isTerminalTaskStatus,
  type TaskDeliveryState,
  type TaskRecord,
  type TaskPersistenceReceipt,
  type TaskRuntime,
  type TaskScopeKind,
  type TaskStatus,
  type TaskNotifyPolicy,
  type TaskDeliveryStatus,
  type TaskTerminalOutcome,
  type JsonValue,
} from "./task-registry.types.js";
import { resolveTaskCleanupAfter } from "./task-retention.js";

export function getTaskRelatedSessionIndexKeys(
  task: Pick<TaskRecord, "requesterSessionKey" | "ownerKey" | "childSessionKey">,
): string[] {
  return uniqueStrings(
    [task.requesterSessionKey, task.ownerKey, task.childSessionKey]
      .map(normalizeOptionalString)
      .filter((key): key is string => Boolean(key)),
  );
}

export function listTasksFromIndex(
  tasks: ReadonlyMap<string, TaskRecord>,
  index: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
): TaskRecord[] {
  const ids = index.get(key);
  if (!ids || ids.size === 0) {
    return [];
  }
  return [...ids]
    .map((taskId, insertionIndex) => {
      const task = tasks.get(taskId);
      return task ? Object.assign({}, cloneTaskRecord(task), { insertionIndex }) : null;
    })
    .filter(
      (
        task,
      ): task is TaskRecord & {
        insertionIndex: number;
      } => Boolean(task),
    )
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _insertionIndex, ...task }) => task);
}

export function selectTaskRecordsForOwnerTree(
  tasks: ReadonlyMap<string, TaskRecord>,
  taskIdsByOwnerKey: ReadonlyMap<string, ReadonlySet<string>>,
  rootOwnerKeys: ReadonlySet<string>,
): TaskRecord[] {
  const owners = new Set(rootOwnerKeys);
  const selected = new Set<string>();
  for (const owner of owners) {
    const key = normalizeOptionalString(owner);
    if (!key) {
      continue;
    }
    for (const taskId of taskIdsByOwnerKey.get(key) ?? []) {
      const task = tasks.get(taskId);
      if (!task || task.scopeKind !== "session") {
        continue;
      }
      selected.add(taskId);
      if (task.childSessionKey) {
        owners.add(task.childSessionKey);
      }
    }
  }
  // Preserve registry insertion order, including descendants inserted before their parents.
  return [...tasks.values()].filter((task) => selected.has(task.taskId));
}

/** Selected rows and every possible parent edge; callers still enforce identity and visibility. */
export function selectTaskRecordsWithAncestors(
  tasks: ReadonlyMap<string, TaskRecord>,
  taskIdsByChildSessionKey: ReadonlyMap<string, ReadonlySet<string>>,
  taskIds: readonly string[],
  isRootTask: (task: Readonly<TaskRecord>) => boolean,
): TaskRecord[] {
  const selected = new Set(taskIds);
  const owners = new Set<string>();
  const records: TaskRecord[] = [];
  for (const taskId of selected) {
    const task = tasks.get(taskId);
    if (!task || task.scopeKind !== "session") {
      continue;
    }
    records.push(task);
    if (isRootTask(task) || owners.has(task.ownerKey)) {
      continue;
    }
    owners.add(task.ownerKey);
    for (const parentId of taskIdsByChildSessionKey.get(task.ownerKey) ?? []) {
      selected.add(parentId);
    }
  }
  return records;
}

/** Build the derived flow index in snapshot order to retain the latest-task tie break. */
export function findLatestTaskForFlowInSnapshot(
  tasks: ReadonlyMap<string, TaskRecord>,
  flowId: string,
): TaskRecord | undefined {
  const linkedTaskIds = new Set(
    [...tasks.values()]
      .filter((task) => task.parentFlowId?.trim() === flowId)
      .map((task) => task.taskId),
  );
  return listTasksFromIndex(tasks, new Map([[flowId, linkedTaskIds]]), flowId)[0];
}

export function compareTasksForRunIdLookup(left: TaskRecord, right: TaskRecord): number {
  const leftPriority = left.runtime === "cli" ? 1 : 0;
  const rightPriority = right.runtime === "cli" ? 1 : 0;
  return leftPriority - rightPriority || left.createdAt - right.createdAt;
}

function taskRunScopeKey(
  task: Pick<TaskRecord, "runtime" | "scopeKind" | "ownerKey" | "childSessionKey">,
): string {
  return [
    task.runtime,
    task.scopeKind,
    normalizeOptionalString(task.ownerKey) ?? "",
    normalizeOptionalString(task.childSessionKey) ?? "",
  ].join("\u0000");
}

export function filterTasksByRunScope<T extends TaskRunScope>(
  records: T[],
  params: { runtime?: TaskRuntime; sessionKey?: string },
): T[] {
  const matches = records.filter((task) => !params.runtime || task.runtime === params.runtime);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (sessionKey) {
    const childMatches = matches.filter(
      (task) => normalizeOptionalString(task.childSessionKey) === sessionKey,
    );
    if (childMatches.length > 0) {
      return childMatches;
    }
    const ownerMatches = matches.filter(
      (task) =>
        task.scopeKind === "session" && normalizeOptionalString(task.ownerKey) === sessionKey,
    );
    return ownerMatches;
  }
  const scopeKeys = new Set(matches.map((task) => taskRunScopeKey(task)));
  return scopeKeys.size <= 1 ? matches : [];
}

type TaskRunScope = Pick<
  TaskRecord,
  "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey"
>;

export function sameTaskRunScope(left: TaskRunScope, right: TaskRunScope): boolean {
  return (
    left.runtime === right.runtime &&
    left.ownerKey === right.ownerKey &&
    left.scopeKind === right.scopeKind &&
    left.runId === right.runId &&
    left.childSessionKey === right.childSessionKey
  );
}

export function captureTaskPersistenceReceipt(
  task: Pick<TaskRecord, keyof TaskPersistenceReceipt>,
): TaskPersistenceReceipt {
  if (!task.runId) {
    throw new Error("Task persistence selection requires a run identity");
  }
  return Object.freeze({
    taskId: task.taskId,
    runtime: task.runtime,
    ownerKey: task.ownerKey,
    scopeKind: task.scopeKind,
    runId: task.runId,
    childSessionKey: task.childSessionKey,
    createdAt: task.createdAt,
    taskKind: task.taskKind,
  });
}

export function matchesTaskPersistenceReceipt(
  task: Pick<TaskRecord, keyof TaskPersistenceReceipt>,
  receipt: TaskPersistenceReceipt,
): boolean {
  return (
    task.taskId === receipt.taskId &&
    task.createdAt === receipt.createdAt &&
    task.taskKind === receipt.taskKind &&
    sameTaskRunScope(task, receipt)
  );
}

export function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    ...(record.executionOwner ? { executionOwner: { ...record.executionOwner } } : {}),
    ...(record.detail !== undefined ? { detail: structuredClone(record.detail) } : {}),
  };
}

export function isEquivalentTaskRecord(current: TaskRecord, next: TaskRecord): boolean {
  const fields = (record: TaskRecord) =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  return isDeepStrictEqual(fields(current), fields(next));
}

/** Observer notifications need detached metadata, never runtime-owned detail. */
export function cloneTaskRecordForObserver(record: TaskRecord): Omit<TaskRecord, "detail"> {
  const { detail: _detail, executionOwner: _executionOwner, ...snapshot } = record;
  return snapshot;
}

export function normalizeTaskTimestamps<
  T extends Pick<TaskRecord, "status" | "createdAt" | "startedAt" | "endedAt" | "lastEventAt">,
>(task: T): T {
  // Detached runtimes can report lifecycle times captured before the registry
  // inserted or restored the row; keep createdAt as the visible lifecycle floor.
  let createdAt = task.createdAt;
  for (const candidate of [task.startedAt, task.lastEventAt, task.endedAt]) {
    if (typeof candidate === "number" && candidate < createdAt) {
      createdAt = candidate;
    }
  }

  const startedAt =
    typeof task.startedAt === "number" ? Math.max(task.startedAt, createdAt) : task.startedAt;
  const terminalAt = isTerminalTaskStatus(task.status)
    ? (task.endedAt ?? task.lastEventAt ?? task.createdAt)
    : task.endedAt;
  const endedAt =
    typeof terminalAt === "number" ? Math.max(terminalAt, startedAt ?? createdAt) : terminalAt;
  const lastEventAt =
    typeof task.lastEventAt === "number"
      ? Math.max(task.lastEventAt, endedAt ?? startedAt ?? createdAt)
      : task.lastEventAt;

  if (
    createdAt === task.createdAt &&
    startedAt === task.startedAt &&
    lastEventAt === task.lastEventAt &&
    endedAt === task.endedAt
  ) {
    return task;
  }

  const normalized: T = {
    ...task,
    createdAt,
  };
  if (typeof startedAt === "number") {
    normalized.startedAt = startedAt;
  }
  if (typeof lastEventAt === "number") {
    normalized.lastEventAt = lastEventAt;
  }
  if (typeof endedAt === "number") {
    normalized.endedAt = endedAt;
  }
  return normalized;
}

export function cloneTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}

export function resolveTaskAgentId(
  params: Pick<TaskRecord, "agentId" | "childSessionKey" | "ownerKey" | "requesterSessionKey">,
): string | undefined {
  return (
    normalizeOptionalString(params.agentId) ??
    parseAgentSessionKey(params.childSessionKey)?.agentId ??
    parseAgentSessionKey(params.ownerKey)?.agentId ??
    parseAgentSessionKey(params.requesterSessionKey)?.agentId
  );
}

function resolveTaskRequesterAgentId(params: {
  explicitRequesterAgentId?: string;
  ownerKey: string;
  requesterSessionKey: string;
}): string | undefined {
  const explicitRequesterAgentId = normalizeOptionalString(params.explicitRequesterAgentId);
  return (
    (explicitRequesterAgentId ? normalizeAgentId(explicitRequesterAgentId) : undefined) ??
    parseAgentSessionKey(params.ownerKey)?.agentId ??
    parseAgentSessionKey(params.requesterSessionKey)?.agentId
  );
}

export type CreateTaskRecordParams = {
  runtime: TaskRuntime;
  executionOwner?: TaskRecord["executionOwner"];
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  requesterAgentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  status?: TaskStatus;
  deliveryStatus?: TaskDeliveryStatus;
  notifyPolicy?: TaskNotifyPolicy;
  startedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
};

export function resolveTaskCreateIdentity(params: CreateTaskRecordParams) {
  const requesterSessionKey = resolveTaskRequesterSessionKey(params);
  const scopeKind = resolveTaskScopeKind({
    scopeKind: params.scopeKind,
    requesterSessionKey,
  });
  const ownerKey = resolveTaskOwnerKey({
    requesterSessionKey,
    ownerKey: params.ownerKey,
  });
  const agentId = resolveTaskAgentId({
    agentId: params.agentId,
    childSessionKey: params.childSessionKey,
    ownerKey,
    requesterSessionKey,
  });
  const requesterAgentId = resolveTaskRequesterAgentId({
    explicitRequesterAgentId: params.requesterAgentId,
    ownerKey,
    requesterSessionKey,
  });
  return { requesterSessionKey, scopeKind, ownerKey, agentId, requesterAgentId };
}

export function buildTaskRecordForCreate(
  params: CreateTaskRecordParams,
  identity: ReturnType<typeof resolveTaskCreateIdentity>,
  { now, taskId }: { now: number; taskId: string },
): { record: TaskRecord; deliveryState?: TaskDeliveryState } {
  const { requesterSessionKey, scopeKind, ownerKey, agentId, requesterAgentId } = identity;
  const status = normalizeTaskStatus(params.status);
  const deliveryStatus =
    params.deliveryStatus ??
    ensureDeliveryStatus({
      ownerKey,
      scopeKind,
    });
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus,
    ownerKey,
    scopeKind,
  });
  const lastEventAt = params.lastEventAt ?? params.startedAt ?? now;
  const runId = normalizeOptionalString(params.runId);
  const childSessionKey = normalizeOptionalString(params.childSessionKey);
  const record: TaskRecord = normalizeTaskTimestamps({
    taskId,
    ...(params.executionOwner ? { executionOwner: { ...params.executionOwner } } : {}),
    runtime: params.runtime,
    taskKind: normalizeOptionalString(params.taskKind),
    sourceId: normalizeOptionalString(params.sourceId),
    requesterSessionKey,
    ownerKey,
    scopeKind,
    ...(childSessionKey ? { childSessionKey } : {}),
    parentFlowId: normalizeOptionalString(params.parentFlowId),
    parentTaskId: normalizeOptionalString(params.parentTaskId),
    agentId,
    requesterAgentId,
    ...(runId ? { runId } : {}),
    label: normalizeOptionalString(params.label),
    task: params.task,
    status,
    deliveryStatus,
    notifyPolicy,
    createdAt: now,
    startedAt: params.startedAt,
    lastEventAt,
    cleanupAfter: params.cleanupAfter,
    progressSummary: normalizeTaskSummary(params.progressSummary),
    terminalSummary: normalizeTaskSummary(params.terminalSummary),
    terminalOutcome: resolveTaskTerminalOutcome({
      status,
      terminalOutcome: params.terminalOutcome,
    }),
    ...(params.detail !== undefined ? { detail: structuredClone(params.detail) } : {}),
  });
  if (isTerminalTaskStatus(record.status) && typeof record.cleanupAfter !== "number") {
    record.cleanupAfter = resolveTaskCleanupAfter(record);
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const deliveryState = requesterOrigin
    ? {
        taskId,
        requesterOrigin,
      }
    : undefined;
  return { record, deliveryState };
}

export function applyTaskRecordPatch(
  current: TaskRecord,
  patch: Partial<TaskRecord>,
  now?: number,
): TaskRecord {
  const updated = {
    ...current,
    ...patch,
    ...(patch.executionOwner ? { executionOwner: { ...patch.executionOwner } } : {}),
    ...(patch.detail !== undefined ? { detail: structuredClone(patch.detail) } : {}),
  };
  if (Object.hasOwn(patch, "runId")) {
    updated.runId = normalizeOptionalString(patch.runId);
  }
  if (Object.hasOwn(patch, "childSessionKey")) {
    updated.childSessionKey = normalizeOptionalString(patch.childSessionKey);
  }
  const becomesTerminal =
    !isTerminalTaskStatus(current.status) && isTerminalTaskStatus(updated.status);
  if (becomesTerminal && patch.endedAt === undefined) {
    updated.endedAt = patch.lastEventAt ?? now ?? Date.now();
  }
  // Terminal freshness cannot regress behind an active snapshot; execution end
  // and nonterminal backdating retain their original meanings.
  if (
    isTerminalTaskStatus(updated.status) &&
    typeof current.lastEventAt === "number" &&
    typeof updated.lastEventAt === "number" &&
    updated.lastEventAt < current.lastEventAt
  ) {
    updated.lastEventAt = current.lastEventAt;
  }
  const next = normalizeTaskTimestamps(updated);
  if (Object.hasOwn(patch, "error") && patch.error === undefined) {
    delete next.error;
  }
  if (Object.hasOwn(patch, "childSessionKey") && updated.childSessionKey === undefined) {
    delete next.childSessionKey;
  }
  if (Object.hasOwn(patch, "runId") && updated.runId === undefined) {
    delete next.runId;
  }
  if (isTerminalTaskStatus(next.status) && typeof next.cleanupAfter !== "number") {
    const createdAt = next.createdAt ?? now ?? Date.now();
    next.cleanupAfter = resolveTaskCleanupAfter({ ...next, createdAt });
  }
  return next;
}

export function pickPreferredRunIdTask(matches: TaskRecord[]): TaskRecord | undefined {
  return [...matches].toSorted(compareTasksForRunIdLookup)[0];
}

export function compareTasksNewestFirst(
  left: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
  right: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
): number {
  const createdAtDiff = right.createdAt - left.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return (right.insertionIndex ?? 0) - (left.insertionIndex ?? 0);
}
