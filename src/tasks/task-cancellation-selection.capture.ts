import {
  matchesTaskCancellationCreatedAt,
  matchesTaskCancellationScope,
  matchesTaskCancellationSelection,
} from "./task-cancellation-selection.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { tasks } from "./task-registry-state.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Retain only witnessed clock corrections, never infer a missing intermediate lifecycle event. */
export function captureTaskCancellationSelection(task: TaskRecord) {
  const selected = cloneTaskRecord(task);
  const store = getTaskRegistryStore();
  const release = onTaskRegistryChange((event) => {
    if (
      !selected.runId?.trim() ||
      getTaskRegistryStore() !== store ||
      event?.kind !== "upserted" ||
      !event.previous ||
      event.previous.createdAt !== selected.createdAt ||
      !matchesTaskCancellationScope(event.previous, selected) ||
      !matchesTaskCancellationScope(event.task, selected) ||
      !matchesTaskCancellationCreatedAt(event.task, selected)
    ) {
      return;
    }
    // Observer payloads omit backing details. Their current resident owner supplies
    // that fence; the preceding committed event supplies the historical clock floor.
    const current = tasks.get(selected.taskId);
    if (
      current &&
      matchesTaskCancellationSelection(current, { ...selected, createdAt: event.task.createdAt })
    ) {
      selected.createdAt = event.task.createdAt;
    }
  });
  return { task: selected, release };
}
