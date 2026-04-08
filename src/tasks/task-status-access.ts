import {
  isAutomationTaskRecord,
  listTasksForAgentId,
  listTasksForSessionKey,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

export function listTasksForSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTasksForSessionKey(sessionKey);
}

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId);
}

export function listAutomationTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId).filter((task) => isAutomationTaskRecord(task));
}
