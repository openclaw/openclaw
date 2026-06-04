import type { HealthSummary } from "../commands/health.js";
import { createChatRunState } from "./server-chat-state.js";

export function createGatewayMaintenanceStateForTest(params?: {
  healthSummary?: HealthSummary;
  healthVersion?: number;
  presenceVersion?: number;
}) {
  const chatRunState = createChatRunState();
  return {
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => params?.presenceVersion ?? 1,
    getHealthVersion: () => params?.healthVersion ?? 1,
    refreshGatewayHealthSnapshot: async () =>
      params?.healthSummary ?? ({ ok: true } as HealthSummary),
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState,
    chatRunBuffers: chatRunState.buffers,
    chatDeltaSentAt: chatRunState.deltaSentAt,
    chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
}
