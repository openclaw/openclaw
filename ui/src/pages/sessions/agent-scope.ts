import type { AgentIdentityResult, SessionsListResult } from "../../api/types.ts";
import type { AgentIdentityCapability } from "../../lib/agents/identity.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

function sessionAgentIds(result: SessionsListResult | null): string[] {
  return [
    ...new Set(
      (result?.sessions ?? [])
        .map((row) => parseAgentSessionKey(row.key)?.agentId)
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ];
}

export function sessionAgentIdentityById(
  result: SessionsListResult | null,
  getIdentity: (agentId: string) => AgentIdentityResult | undefined,
): Record<string, AgentIdentityResult> {
  return Object.fromEntries(
    sessionAgentIds(result)
      .map((agentId) => [agentId, getIdentity(agentId)] as const)
      .filter((entry): entry is readonly [string, AgentIdentityResult] => Boolean(entry[1])),
  );
}

export function ensureSessionAgentIdentities(
  identity: Pick<AgentIdentityCapability, "get" | "ensure"> | undefined,
  result: SessionsListResult | null,
): void {
  if (!identity || !result) {
    return;
  }
  const agentIds = sessionAgentIds(result).filter((agentId) => !identity.get(agentId));
  if (agentIds.length === 0) {
    return;
  }
  void identity.ensure(agentIds);
}
