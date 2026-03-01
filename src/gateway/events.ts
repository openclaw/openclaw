import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
export const GATEWAY_EVENT_AGENT_MESSAGE = "agent.message" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export type GatewayAgentMessageEventPayload = {
  sourceSessionKey: string;
  targetSessionKey: string;
  message: string;
  correlationId?: string;
  ts: number;
};
