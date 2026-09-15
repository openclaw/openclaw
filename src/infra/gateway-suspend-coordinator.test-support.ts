import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";

export function inspectors(
  overrides: Partial<GatewayActiveWorkInspectors> = {},
): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
    getPluginParticipants: () => [],
    ...overrides,
  };
}
