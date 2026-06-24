// Identifies childless native-subagent task rows that are owned by an external
// harness and therefore cannot be recovered through an OpenClaw child session.
import type { TaskRecord } from "./task-registry.types.js";

export const COPILOT_NATIVE_SUBAGENT_TASK_KIND = "copilot-native";
export const COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX = "copilot-agent:";
export const COPILOT_NATIVE_SUBAGENT_STALE_ERROR =
  "Copilot native subagent stopped reporting progress";

const CHILDLESS_NATIVE_SUBAGENT_DEFINITIONS = [
  {
    taskKind: "codex-native",
    runIdPrefix: "codex-thread:",
  },
  {
    taskKind: COPILOT_NATIVE_SUBAGENT_TASK_KIND,
    runIdPrefix: COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  },
] as const;

export type NativeSubagentTaskDefinition = (typeof CHILDLESS_NATIVE_SUBAGENT_DEFINITIONS)[number];

export function resolveChildlessNativeSubagentTaskDefinition(
  task: TaskRecord,
): NativeSubagentTaskDefinition | undefined {
  if (task.runtime !== "subagent" || task.childSessionKey?.trim()) {
    return undefined;
  }
  return CHILDLESS_NATIVE_SUBAGENT_DEFINITIONS.find(
    (definition) =>
      task.taskKind === definition.taskKind &&
      [task.sourceId, task.runId].some((candidate) =>
        candidate?.trim().startsWith(definition.runIdPrefix),
      ),
  );
}

export function isChildlessNativeSubagentTask(task: TaskRecord): boolean {
  return resolveChildlessNativeSubagentTaskDefinition(task) !== undefined;
}
