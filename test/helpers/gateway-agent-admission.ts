import { expect } from "vitest";
import type { AgentsListResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { GatewayClient } from "../../src/gateway/client.js";

/** Gateway readiness can precede a selected agent's database inspection. */
export async function assertGatewayAgentsAdmitted(
  client: Pick<GatewayClient, "request">,
  expectedAgentIds: readonly string[],
): Promise<void> {
  const { agents } = await client.request<AgentsListResult>("agents.list", {});
  for (const agentId of expectedAgentIds) {
    const matches = agents.filter((agent) => agent.id === agentId);
    expect(matches.length, `Expected exactly one Gateway agent ${agentId}`).toBe(1);
    const agent = matches[0]!;
    expect(agent.status, `Gateway agent ${agentId} is degraded`).toBeUndefined();
    expect(
      agent.admissionRefusal === undefined,
      `Gateway agent ${agentId} has an admission refusal`,
    ).toBe(true);
  }
}
