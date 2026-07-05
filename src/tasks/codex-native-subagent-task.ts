// Runs Codex native subagent tasks and maps their lifecycle into task registry state.
import {
  isChildlessNativeSubagentTask,
  resolveChildlessNativeSubagentTaskDefinition,
} from "./native-subagent-task.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Runtime label used for Codex-native subagent task records. */
export const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
export const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
export const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";
export const CODEX_NATIVE_SUBAGENT_STALE_ERROR = "Codex native subagent stopped reporting progress";

/** Detects native Codex subagent tasks that have no child session to recover from. */
export function isChildlessCodexNativeSubagentTask(task: TaskRecord): boolean {
  return (
    isChildlessNativeSubagentTask(task) &&
    resolveChildlessNativeSubagentTaskDefinition(task)?.taskKind === CODEX_NATIVE_SUBAGENT_TASK_KIND
  );
}
