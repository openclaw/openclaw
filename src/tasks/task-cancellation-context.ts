import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readTaskBackingInstance, sameTaskBackingInstance } from "./task-backing-records.js";
import { captureTaskCancellationSelection } from "./task-cancellation-selection.capture.js";
import { matchesTaskCancellationCreatedAt } from "./task-cancellation-selection.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskCancellationTarget = Readonly<
  Pick<TaskRecord, "taskId" | "scopeKind" | "ownerKey" | "requesterAgentId">
>;

export type TaskCancellationControl = {
  prepareRead?: () => Promise<void> | undefined;
  assertCurrent: () => void;
};

type TaskCancellationContext = {
  isActive: () => boolean;
  assertSelected: (task: TaskRecord | undefined) => void;
  assertCurrent: (task: TaskCancellationTarget) => void;
  prepareRead: () => Promise<void> | undefined;
};

const contexts = resolveGlobalSingleton(Symbol.for("openclaw.taskCancellationContext"), () => ({
  caller: new AsyncLocalStorage<TaskCancellationContext>(),
  prepared: new AsyncLocalStorage<TaskCancellationControl>(),
}));

/** Carry caller authority through runtime handoffs without extending the public cancel request. */
export async function withTaskCancellationContext<T>(
  assertCurrent: (task: TaskCancellationTarget) => void,
  operation: () => Promise<T>,
  options: {
    selectedTask?: TaskRecord;
    prepareRead?: () => Promise<void> | undefined;
  } = {},
): Promise<T> {
  const parent = contexts.caller.getStore();
  const inherited = parent?.isActive() ? parent : undefined;
  const inheritedControl = inherited ? contexts.prepared.getStore() : undefined;
  const selection = options.selectedTask && captureTaskCancellationSelection(options.selectedTask);
  const selected = selection?.task;
  const selectedBacking =
    options.selectedTask && readTaskBackingInstance(options.selectedTask.detail);
  let active = true;
  const context: TaskCancellationContext = {
    isActive: () => active,
    prepareRead: () => {
      if (!active) {
        throw new Error("Cancellation is no longer authorized.");
      }
      return (
        inheritedControl?.prepareRead?.() ?? inherited?.prepareRead() ?? options.prepareRead?.()
      );
    },
    assertSelected: (task) => {
      inherited?.assertSelected(task);
      if (!selected) {
        return;
      }
      const backing = task && readTaskBackingInstance(task.detail);
      if (
        !task ||
        task.taskId !== selected.taskId ||
        task.scopeKind !== selected.scopeKind ||
        task.ownerKey !== selected.ownerKey ||
        task.requesterAgentId !== selected.requesterAgentId ||
        task.runtime !== selected.runtime ||
        task.runId !== selected.runId ||
        task.childSessionKey !== selected.childSessionKey ||
        task.sourceId !== selected.sourceId ||
        !matchesTaskCancellationCreatedAt(task, selected) ||
        (selectedBacking
          ? !backing || !sameTaskBackingInstance(selectedBacking, backing)
          : backing !== undefined)
      ) {
        throw new Error("Task changed while cancellation was in progress.");
      }
    },
    assertCurrent: (task) => {
      if (!active) {
        throw new Error("Cancellation is no longer authorized.");
      }
      inheritedControl?.assertCurrent();
      inherited?.assertCurrent(task);
      assertCurrent(task);
    },
  };
  try {
    return await contexts.prepared.exit(() => contexts.caller.run(context, operation));
  } finally {
    active = false;
    selection?.release();
  }
}

/** Undefined keeps ready callers in the current frame; consumers recheck after a pending read. */
export function prepareTaskCancellationRead(): Promise<void> | undefined {
  const prepared = contexts.prepared.getStore();
  return prepared ? prepared.prepareRead?.() : contexts.caller.getStore()?.prepareRead();
}

/** Bind the assertion to the cancellation owner's task snapshot before it yields. */
export function prepareTaskCancellationControl(
  task: TaskRecord | undefined,
): TaskCancellationControl | undefined {
  const context = contexts.caller.getStore();
  if (!context) {
    return undefined;
  }
  context.assertSelected(task);
  const target: TaskCancellationTarget | undefined = task && {
    taskId: task.taskId,
    scopeKind: task.scopeKind,
    ownerKey: task.ownerKey,
    requesterAgentId: task.requesterAgentId,
  };
  return {
    prepareRead: context.prepareRead,
    assertCurrent: () => {
      if (!target) {
        throw new Error("Task is no longer available for cancellation.");
      }
      context.assertCurrent(target);
    },
  };
}

export function withTaskCancellationControl<T>(
  control: TaskCancellationControl | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return control ? contexts.prepared.run(control, operation) : operation();
}

export function captureTaskCancellationControl(): TaskCancellationControl | undefined {
  return contexts.prepared.getStore();
}
