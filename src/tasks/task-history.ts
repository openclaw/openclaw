import { listRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { isHarnessOwnedSubagentTask } from "./harness-owned-subagent-task.js";
import type { TaskRecord } from "./task-registry.types.js";

/** History routing must not change which runtime owns a task's lifecycle. */
export function resolveTaskHistoryHarness(task: TaskRecord) {
  if (!isHarnessOwnedSubagentTask(task)) {
    return undefined;
  }
  const owners = listRegisteredAgentHarnesses().filter(({ harness }) =>
    harness.taskHistory?.taskKinds.includes(task.taskKind ?? ""),
  );
  return owners.length === 1 ? owners[0]?.harness : undefined;
}

export function taskTranscriptSessionKey(task: TaskRecord): string | undefined {
  return task.runtime === "subagent"
    ? task.childSessionKey?.trim() || undefined
    : task.childSessionKey?.trim() || task.requesterSessionKey.trim() || undefined;
}

export function hasTaskTranscript(task: TaskRecord): boolean {
  return Boolean(taskTranscriptSessionKey(task) || resolveTaskHistoryHarness(task));
}
