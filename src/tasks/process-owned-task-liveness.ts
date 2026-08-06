import { resolveGlobalSet } from "../shared/global-singleton.js";
import type { TaskRecord } from "./task-registry.types.js";

export const CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";

const ACTIVE_PROCESS_OWNED_TASK_IDS_KEY = Symbol.for("openclaw.processOwnedTaskIds");

function getActiveProcessOwnedTaskIds(): Set<string> {
  return resolveGlobalSet<string>(ACTIVE_PROCESS_OWNED_TASK_IDS_KEY, "close-and-restart");
}

export function isNonResumableProcessOwnedTask(
  task: Pick<TaskRecord, "runtime" | "taskKind">,
): boolean {
  return task.runtime === "acp" && task.taskKind === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND;
}

export function registerProcessOwnedTaskId(taskId: string): () => void {
  const activeTaskIds = getActiveProcessOwnedTaskIds();
  activeTaskIds.add(taskId);
  return () => {
    activeTaskIds.delete(taskId);
  };
}

export function isProcessOwnedTaskIdActive(taskId: string): boolean {
  return getActiveProcessOwnedTaskIds().has(taskId);
}

function resetProcessOwnedTaskLivenessForTests(): void {
  getActiveProcessOwnedTaskIds().clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.processOwnedTaskLivenessTestApi")
  ] = { resetProcessOwnedTaskLivenessForTests };
}
