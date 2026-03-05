import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
export const GATEWAY_EVENT_AGENT_ACTIVITY = "agent.activity" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export type GatewayAgentActivityState = "generating" | "tool" | "idle" | "error";

export type GatewayAgentActivityEventPayload = {
  runId: string;
  sessionKey?: string;
  agent: string;
  state: GatewayAgentActivityState;
  task?: string;
  phase?: string;
  seq: number;
  ts: number;
};
