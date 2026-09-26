import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isIncognitoTask, projectTaskContentForPersistence } from "./task-content.js";
import { assertTaskOwner } from "./task-registry-common.js";
import { buildTaskCreateMergePatch } from "./task-registry-create-rules.js";
import {
  applyTaskRecordPatch,
  buildTaskRecordForCreate,
  isEquivalentTaskRecord,
  resolveTaskCreateIdentity,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  isTerminalTaskStatus,
  type TaskDeliveryState,
  type TaskRecord,
} from "./task-registry.types.js";

export type TaskCreateInput = {
  params: CreateTaskRecordParams;
  taskId: string;
  now: number;
};

export type TaskCreateResult = {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
} & (
  | { mutation: "created"; persisted: true }
  | { mutation: "updated"; previous: TaskRecord; persisted: boolean }
  | { mutation: "reused"; persisted: false }
);

type TaskCreateCommit =
  | { kind: "delivery"; task: TaskRecord; deliveryState: TaskDeliveryState }
  | { kind: "task"; result: TaskCreateResult };

export type TaskCreateOperations = {
  readSelection: (
    identity: ReturnType<typeof resolveTaskCreateIdentity>,
    params: CreateTaskRecordParams,
  ) => {
    existing?: TaskRecord;
    deliveryState?: TaskDeliveryState;
  };
  write: <T>(operation: () => T) => T;
  /** Upserts must throw on persistence failure; returning acknowledges the write. */
  upsertDelivery: (state: TaskDeliveryState) => void;
  upsertTask: (task: TaskRecord, deliveryState?: TaskDeliveryState) => void;
  /** Native adapters stage rollback-safe state; worker adapters publish after commit. */
  deferCommit: (publish: () => void) => void;
  retainTaskCommit?: (taskId: string) => void;
  onCommitted: (commit: TaskCreateCommit) => void;
  assertCurrent?: (existing: TaskRecord | undefined) => void;
};

/** Adapters retain writer custody and their existing separate commit boundaries. */
export function runTaskCreateOperation(
  input: TaskCreateInput,
  operations: TaskCreateOperations,
): TaskCreateResult {
  const params = projectTaskContentForPersistence(isIncognitoTask(input.params), input.params);
  const identity = resolveTaskCreateIdentity(params);
  assertTaskOwner(identity);
  const publishResult = (result: TaskCreateResult) => {
    operations.retainTaskCommit?.(result.task.taskId);
    operations.deferCommit(() => operations.onCommitted({ kind: "task", result }));
    return result;
  };
  const mergeExisting = (existing: TaskRecord, deliveryState?: TaskDeliveryState) => {
    const patch = buildTaskCreateMergePatch(existing, { ...params, agentId: identity.agentId });
    const hasPatch = Object.keys(patch).length > 0;
    const task = hasPatch ? applyTaskRecordPatch(existing, patch, input.now) : existing;
    const persisted =
      hasPatch &&
      (!isTerminalTaskStatus(existing.status) || !isEquivalentTaskRecord(existing, task));
    operations.assertCurrent?.(existing);
    if (persisted) {
      operations.upsertTask(task, deliveryState);
    }
    return publishResult(
      hasPatch
        ? { task, deliveryState, mutation: "updated", previous: existing, persisted }
        : { task, deliveryState, mutation: "reused", persisted: false },
    );
  };
  const initial = operations.write(() => {
    const { existing, deliveryState: existingDeliveryState } = operations.readSelection(
      identity,
      params,
    );
    if (existing) {
      const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
      if (requesterOrigin && !existingDeliveryState?.requesterOrigin) {
        const nextDeliveryState: TaskDeliveryState = {
          taskId: existing.taskId,
          requesterOrigin,
          lastNotifiedEventAt: existingDeliveryState?.lastNotifiedEventAt,
        };
        operations.assertCurrent?.(existing);
        operations.upsertDelivery(nextDeliveryState);
        operations.retainTaskCommit?.(existing.taskId);
        operations.deferCommit(() =>
          operations.onCommitted({
            kind: "delivery",
            task: existing,
            deliveryState: nextDeliveryState,
          }),
        );
        return { existingTaskId: existing.taskId };
      }
      return { result: mergeExisting(existing, existingDeliveryState) };
    }
    const { record: task, deliveryState } = buildTaskRecordForCreate(params, identity, input);
    operations.assertCurrent?.(undefined);
    operations.upsertTask(task, deliveryState);
    return {
      result: publishResult({ task, deliveryState, mutation: "created", persisted: true }),
    };
  });
  if (initial.result) {
    return initial.result;
  }
  // Filling a missing origin is already committed even if this metadata stage fails.
  return operations.write(() => {
    const { existing, deliveryState } = operations.readSelection(identity, params);
    if (!existing || existing.taskId !== initial.existingTaskId) {
      throw new Error("Task creation selection changed before metadata reuse.");
    }
    return mergeExisting(existing, deliveryState);
  });
}
