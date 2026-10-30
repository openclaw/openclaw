import type { AgentIdentityResult, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

export function sessionAgentId(key: string, context: ApplicationContext): string | undefined {
  const { agentId } = scopedAgentParamsForSession(
    {
      assistantAgentId: context.agentSelection.state.selectedId,
      hello: context.gateway.snapshot.hello,
    },
    key,
  );
  return agentId;
}

export function sessionPathAgentId(key: string, context: ApplicationContext): string {
  return sessionAgentId(key, context) ?? resolveSessionNavigationAgentId(context);
}

export function sessionAgentIds(result: SessionsListResult | null): string[] {
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
