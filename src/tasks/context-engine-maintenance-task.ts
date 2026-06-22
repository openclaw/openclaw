// Defines the task-registry identity for core context-engine turn maintenance.
import type { TaskRecord } from "./task-registry.types.js";

export const CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";

export function isContextEngineTurnMaintenanceTask(
  task: Pick<TaskRecord, "childSessionKey" | "runtime" | "scopeKind" | "sourceId" | "taskKind">,
): boolean {
  return (
    task.runtime === "acp" &&
    task.scopeKind === "session" &&
    task.taskKind?.trim() === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND &&
    task.sourceId?.trim() === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND &&
    !task.childSessionKey?.trim()
  );
}
