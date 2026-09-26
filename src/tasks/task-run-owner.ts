import { err } from "@openclaw/normalization-core/result";
import { captureTaskExecutionOwner } from "./task-execution-owner.js";
import { updateTask } from "./task-registry-mutation.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
  sameTaskRunScope,
} from "./task-registry-records.js";
import { withTaskRegistryMutation } from "./task-registry-state.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
import type { TaskPersistenceReceipt, TaskRecord } from "./task-registry.types.js";
import type { TaskRunOwner, TaskRunOwnerBinding } from "./task-run-owner.types.js";

export function getTaskRunOwner(task: TaskRunOwner["task"]): TaskRunOwner | undefined {
  const owner = getTaskRegistryProcessState().runOwners.get(task.taskId);
  // Store reloads replace record objects, but cannot transfer the producer's fixed task scope.
  return owner && sameTaskRunScope(owner.task, task) ? owner : undefined;
}

export function bindTaskRunOwner(task: TaskRecord, cancel: TaskRunOwner["cancel"]): () => void {
  return withTaskRegistryMutation(() => bindCurrentTaskRunOwner(task, cancel));
}

export function captureTaskRunOwnerBinding(
  task: TaskPersistenceReceipt,
  cancel: TaskRunOwner["cancel"],
) {
  const state = getTaskRegistryProcessState();
  const selected = captureTaskPersistenceReceipt(task);
  const previousOwner = state.runOwners.get(selected.taskId);
  const assertCurrent = () => {
    if (state.runOwners.get(selected.taskId) !== previousOwner) {
      throw new Error("Task run owner was replaced before binding.");
    }
  };
  return {
    assertCurrent,
    bind(expectedTask: TaskPersistenceReceipt): TaskRunOwnerBinding {
      assertCurrent();
      const current = state.tasks.get(selected.taskId);
      if (
        expectedTask.taskId !== selected.taskId ||
        expectedTask.taskKind !== selected.taskKind ||
        !sameTaskRunScope(expectedTask, selected) ||
        !current ||
        !matchesTaskPersistenceReceipt(current, expectedTask)
      ) {
        throw new Error("Task no longer belongs to this live run.");
      }
      return installTaskRunOwner(expectedTask, cancel);
    },
  };
}

function bindCurrentTaskRunOwner(task: TaskRecord, cancel: TaskRunOwner["cancel"]): () => void {
  const state = getTaskRegistryProcessState();
  const registeredTask = state.tasks.get(task.taskId);
  if (!registeredTask || !sameTaskRunScope(registeredTask, task)) {
    throw new Error("Task no longer belongs to this live run.");
  }
  const executionOwner = captureTaskExecutionOwner();
  if (executionOwner && registeredTask.status === "running") {
    updateTask(task.taskId, { executionOwner });
  }
  return installTaskRunOwner(task, cancel).release;
}

function installTaskRunOwner(task: TaskRunOwner["task"], cancel: TaskRunOwner["cancel"]) {
  const state = getTaskRegistryProcessState();
  const owner: TaskRunOwner = {
    task,
    cancel: (reason) => {
      const current = state.tasks.get(task.taskId);
      // Retained callbacks cannot control deleted, rebound, or replaced tasks.
      if (!current || getTaskRunOwner(current) !== owner) {
        return Promise.resolve(err("Task no longer belongs to this live run."));
      }
      return cancel(reason);
    },
  };
  state.runOwners.set(task.taskId, owner);
  return {
    owner,
    release: () => {
      // An old producer must not remove its replacement's registration.
      if (state.runOwners.get(task.taskId) === owner) {
        state.runOwners.delete(task.taskId);
      }
    },
  };
}
