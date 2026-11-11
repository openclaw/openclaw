import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsCreateResult } from "../../api/types.ts";

export type AgentCreationResult = Pick<AgentsCreateResult, "agentId" | "name"> & {
  onboarding: NonNullable<AgentsCreateResult["onboarding"]>;
};

export type AgentCreationAttempt = {
  agentId: string;
  name: string;
  avatar?: string;
  receipt?: AgentCreationResult;
  rejection?: unknown;
  responseReceived?: boolean;
};

export type AgentCreationRequest = {
  client: GatewayBrowserClient;
  attempt: AgentCreationAttempt;
  previous: boolean;
  attempts: Map<string, AgentCreationAttempt>;
};
