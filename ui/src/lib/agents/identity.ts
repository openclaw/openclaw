import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";

type AgentIdentityGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
  };
};

export type AgentIdentityCapability = {
  getMany: (agentIds: readonly string[]) => Promise<Record<string, AgentIdentityResult>>;
};

export function createAgentIdentityCapability(
  gateway: AgentIdentityGateway,
): AgentIdentityCapability {
  let cachedClient: GatewayBrowserClient | null = null;
  const identities = new Map<string, AgentIdentityResult>();

  return {
    async getMany(agentIds) {
      const client = gateway.snapshot.client;
      if (!client || !gateway.snapshot.connected) {
        return {};
      }
      if (client !== cachedClient) {
        cachedClient = client;
        identities.clear();
      }
      const missing = [...new Set(agentIds)].filter((agentId) => !identities.has(agentId));
      const results = await Promise.all(
        missing.map(async (agentId) => {
          try {
            return [
              agentId,
              await client.request<AgentIdentityResult | null>("agent.identity.get", { agentId }),
            ] as const;
          } catch {
            return [agentId, null] as const;
          }
        }),
      );
      if (gateway.snapshot.client !== client) {
        return {};
      }
      for (const [agentId, identity] of results) {
        if (identity) {
          identities.set(agentId, identity);
        }
      }
      return Object.fromEntries(identities);
    },
  };
}
