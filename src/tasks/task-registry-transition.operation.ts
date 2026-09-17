import {
  appendTaskEvent,
  normalizeTaskStatus,
  normalizeTaskSummary,
  resolveTaskTerminalOutcome,
  shouldApplyRunScopedStatusUpdate,
} from "./task-registry-common.js";
import {
  applyTaskRecordPatch,
  filterTasksByRunScope,
  isEquivalentTaskRecord,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import {
  isTerminalTaskStatus,
  type JsonValue,
  type TaskDeliveryStatus,
  type TaskEventRecord,
  type TaskRecord,
  type TaskPersistenceReceipt,
  type TaskRuntime,
  type TaskStatus,
  type TaskTerminalOutcome,
} from "./task-registry.types.js";

export type TaskRunStateTransitionParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  childSessionKey?: string | null;
  status?: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  clearError?: boolean;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
  eventSummary?: string | null;
  suppressDelivery?: boolean;
};

type TaskRunDeliveryTransitionParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
};

export type TaskRunTransition =
  | { kind: "state"; params: TaskRunStateTransitionParams }
  | { kind: "delivery"; params: TaskRunDeliveryTransitionParams };

export type TaskRecordTransitionInput = TaskRunTransition & {
  taskId: string;
  now: number;
  expectedTask?: TaskPersistenceReceipt;
  /** Preserve an initial batch match across sibling writes; this is not live authority. */
  selection?: TaskPersistenceReceipt;
};

type TaskRecordUpdate = {
  previous: TaskRecord;
  task: TaskRecord;
  persisted: boolean;
  becomesTerminal: boolean;
};

export type TaskRecordTransitionReceipt = TaskRecordUpdate & {
  deliver: boolean;
  nextEvent?: TaskEventRecord;
};

/** This is also the ordinary synchronous update owner's persistence/no-op decision. */
export function prepareTaskRecordUpdate(
  current: TaskRecord,
  patch: Partial<TaskRecord>,
  now?: number,
): TaskRecordUpdate {
  const task = applyTaskRecordPatch(current, patch, now);
  return {
    previous: current,
    task,
    persisted: !isTerminalTaskStatus(current.status) || !isEquivalentTaskRecord(current, task),
    becomesTerminal: !isTerminalTaskStatus(current.status) && isTerminalTaskStatus(task.status),
  };
}

function prepareStateTransition(
  current: TaskRecord,
  params: TaskRunStateTransitionParams,
  now: number,
) {
  const patch: Partial<TaskRecord> = {};
  const nextStatus = params.status ? normalizeTaskStatus(params.status) : current.status;
  if (
    params.status &&
    !shouldApplyRunScopedStatusUpdate({
      currentStatus: current.status,
      currentRuntime: current.runtime,
      currentChildSessionKey: current.childSessionKey,
      currentError: current.error,
      currentEndedAt: current.endedAt,
      nextStatus,
      nextError: params.error,
      nextEndedAt: params.endedAt,
    })
  ) {
    return null;
  }
  const eventAt = params.lastEventAt ?? params.endedAt ?? now;
  if (params.status) {
    patch.status = normalizeTaskStatus(params.status);
  }
  if (params.startedAt != null) {
    patch.startedAt = params.startedAt;
  }
  if (params.endedAt != null) {
    patch.endedAt = params.endedAt;
  }
  if (params.lastEventAt != null) {
    patch.lastEventAt = params.lastEventAt;
  }
  if (params.childSessionKey !== undefined) {
    patch.childSessionKey = params.childSessionKey?.trim() || undefined;
  }
  if (params.clearError) {
    patch.error = undefined;
  } else if (
    current.status === "cancelled" &&
    nextStatus !== "cancelled" &&
    params.error === undefined
  ) {
    patch.error = undefined;
  } else if (params.error !== undefined) {
    patch.error = params.error;
  }
  if (params.progressSummary !== undefined) {
    patch.progressSummary = normalizeTaskSummary(params.progressSummary);
  }
  if (params.terminalSummary !== undefined) {
    patch.terminalSummary = params.preserveTerminalSummary
      ? (params.terminalSummary ?? undefined)
      : normalizeTaskSummary(params.terminalSummary);
  }
  if (params.terminalOutcome !== undefined) {
    patch.terminalOutcome = resolveTaskTerminalOutcome({
      status: nextStatus,
      terminalOutcome: params.terminalOutcome,
    });
  }
  if (params.detail !== undefined) {
    patch.detail = params.detail;
  }
  if (params.suppressDelivery) {
    // Teardown suppression must survive redundant lifecycle finalizers that
    // arrive after queues are cleared, or they can repopulate the stopped session.
    patch.deliveryStatus = "not_applicable";
  }
  const eventSummary =
    normalizeTaskSummary(params.eventSummary) ??
    (nextStatus === "failed"
      ? normalizeTaskSummary(params.error ?? current.error)
      : nextStatus === "succeeded"
        ? normalizeTaskSummary(params.terminalSummary ?? current.terminalSummary)
        : undefined);
  const shouldAppendEvent =
    (params.status && params.status !== current.status) ||
    Boolean(normalizeTaskSummary(params.eventSummary));
  const nextEvent = shouldAppendEvent
    ? appendTaskEvent({
        at: eventAt,
        kind:
          params.status && normalizeTaskStatus(params.status) !== current.status
            ? normalizeTaskStatus(params.status)
            : "progress",
        summary: eventSummary,
      })
    : undefined;
  return { patch, nextEvent };
}

function prepareTaskRecordTransition(
  current: TaskRecord,
  input: TaskRunTransition & { now: number },
): TaskRecordTransitionReceipt | null {
  if (input.kind === "delivery") {
    return {
      ...prepareTaskRecordUpdate(
        current,
        {
          deliveryStatus: input.params.deliveryStatus,
          ...(input.params.error !== undefined ? { error: input.params.error } : {}),
        },
        input.now,
      ),
      deliver: false,
    };
  }
  const prepared = prepareStateTransition(current, input.params, input.now);
  return prepared
    ? {
        ...prepareTaskRecordUpdate(current, prepared.patch, input.now),
        deliver: !input.params.suppressDelivery,
        nextEvent: prepared.nextEvent,
      }
    : null;
}

export type TaskRecordTransitionOperations = {
  /** Re-select the exact row against the current run scope before deciding its patch. */
  readCurrent: () => TaskRecord | undefined;
  hasAuthoritativeBacking: (task: TaskRecord) => boolean;
  write: <T>(operation: () => T) => T;
  /** False retains the legacy best-effort failed-row behavior; worker stores throw. */
  upsertTask: (task: TaskRecord) => boolean;
  beforePersist?: (receipt: TaskRecordTransitionReceipt) => void;
  assertCurrent?: (receipt: TaskRecordTransitionReceipt) => void;
  deferCommit: (publish: () => void) => void;
  onCommitted: (receipt: TaskRecordTransitionReceipt) => void;
};

/** Callers publish each settled row before selecting/admitting the next sibling. */
export function runTaskRecordTransitionOperation(
  input: TaskRecordTransitionInput,
  operations: TaskRecordTransitionOperations,
): TaskRecordTransitionReceipt | null {
  return operations.write(() => {
    if (input.expectedTask && !operations.assertCurrent) {
      throw new Error("A task persistence receipt requires live owner admission");
    }
    const current = operations.readCurrent();
    if (
      !current ||
      (input.selection &&
        (!matchesTaskPersistenceReceipt(current, input.selection) ||
          current.runId?.trim() !== input.params.runId.trim() ||
          filterTasksByRunScope([current], input.params).length === 0)) ||
      (input.expectedTask && !matchesTaskPersistenceReceipt(current, input.expectedTask)) ||
      !operations.hasAuthoritativeBacking(current)
    ) {
      return null;
    }
    const receipt = prepareTaskRecordTransition(current, input);
    if (!receipt) {
      return null;
    }
    operations.beforePersist?.(receipt);
    operations.assertCurrent?.(receipt);
    if (receipt.persisted && !operations.upsertTask(receipt.task)) {
      return null;
    }
    // No-op rows still owe flow repair and observer/delivery publication.
    operations.deferCommit(() => operations.onCommitted(receipt));
    return receipt;
  });
}
