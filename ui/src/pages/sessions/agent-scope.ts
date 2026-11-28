import type { AgentIdentityResult, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { usesGatewayTimedSessionPins } from "../../lib/gateway-methods.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import {
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";

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

/** Resolve the table's navigation from the same connected agent and profile as its menu. */
export function sessionTableNavigation(context: ApplicationContext) {
  const gateway = context.gateway.snapshot;
  return {
    agentId: resolveSessionNavigationAgentId(context),
    allAgentsScope: context.agentSelection.state.scopeId === null,
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: gateway.hello,
    }),
    personalSidebarEntries: context.navigation.snapshot.sidebarEntries,
    gatewayTimedPins: usesGatewayTimedSessionPins(gateway),
  };
}

export function sessionAgentIds(rows: readonly GatewaySessionRow[]): string[] {
  return [
    ...new Set(
      rows
        .map((row) => parseAgentSessionKey(row.key)?.agentId)
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ];
}

export function sessionAgentIdentityById(
  rows: readonly GatewaySessionRow[],
  getIdentity: (agentId: string) => AgentIdentityResult | undefined,
): Record<string, AgentIdentityResult> {
  return Object.fromEntries(
    sessionAgentIds(rows)
      .map((agentId) => [agentId, getIdentity(agentId)] as const)
      .filter((entry): entry is readonly [string, AgentIdentityResult] => Boolean(entry[1])),
  );
}
