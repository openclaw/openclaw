import { listTasksForAgentId, listTasksForSessionKey } from "./task-registry.js";
export function listTasksForSessionKeyForStatus(sessionKey) {
    return listTasksForSessionKey(sessionKey);
}
export function listTasksForAgentIdForStatus(agentId) {
    return listTasksForAgentId(agentId);
}
