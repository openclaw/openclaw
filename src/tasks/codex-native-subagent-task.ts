// Runs Codex native subagent tasks and maps their lifecycle into task registry state.
<<<<<<< HEAD
import {
  isChildlessNativeSubagentTask,
  resolveChildlessNativeSubagentTaskDefinition,
} from "./native-subagent-task.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { TaskRecord } from "./task-registry.types.js";

/** Runtime label used for Codex-native subagent task records. */
export const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
export const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
export const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";
export const CODEX_NATIVE_SUBAGENT_STALE_ERROR = "Codex native subagent stopped reporting progress";

/** Detects native Codex subagent tasks that have no child session to recover from. */
export function isChildlessCodexNativeSubagentTask(task: TaskRecord): boolean {
<<<<<<< HEAD
  return (
    isChildlessNativeSubagentTask(task) &&
    resolveChildlessNativeSubagentTaskDefinition(task)?.taskKind === CODEX_NATIVE_SUBAGENT_TASK_KIND
=======
  if (
    task.runtime !== CODEX_NATIVE_SUBAGENT_RUNTIME ||
    task.taskKind !== CODEX_NATIVE_SUBAGENT_TASK_KIND
  ) {
    return false;
  }
  if (task.childSessionKey?.trim()) {
    return false;
  }
  return [task.sourceId, task.runId].some((candidate) =>
    candidate?.trim().startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}
