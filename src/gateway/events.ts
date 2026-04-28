import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export const GATEWAY_EVENT_AGENT_RUN_STATUS = "agent.run.status" as const;

export type AgentRunStatusEventStatus = "started" | "completed" | "failed" | "interrupted";

export type GatewayAgentRunStatusEventPayload = {
  agentId: string;
  sessionKey: string;
  status: AgentRunStatusEventStatus;
  startedAt: number;
  model?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
  };
  toolCallCount?: number;
  exitReason?: string;
};
