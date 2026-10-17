import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsCreateResult } from "../../api/types.ts";

export type AgentCreationResult = Pick<AgentsCreateResult, "agentId" | "name"> & {
  onboarding: NonNullable<AgentsCreateResult["onboarding"]>;
};

export type AgentCreationAttempt = {
  agentId: string;
  name: string;
  receipt?: AgentCreationResult;
  rejection?: unknown;
  responseReceived?: boolean;
};

/** Owns attempted identities until a response or saved config proves the write's outcome. */
export function createAgentCreationRecovery() {
  const attempts = new Map<string, AgentCreationAttempt>();
  return {
    prepare(client: GatewayBrowserClient, name: string) {
      const target = client.gatewayUrl;
      const previous = attempts.get(target);
      const attempt = previous ?? { agentId: `bot-${crypto.randomUUID()}`, name };
      return {
        agentId: attempt.agentId,
        name: attempt.name,
        async execute(isCurrent: () => boolean): Promise<AgentCreationResult | null> {
          const { executeAgentCreation } = await import("./creation-recovery.runtime.ts");
          return executeAgentCreation(client, attempt, Boolean(previous), attempts, isCurrent);
        },
      };
    },
    dispose() {
      attempts.clear();
    },
  };
}
