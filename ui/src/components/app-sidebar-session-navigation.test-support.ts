import type { GatewaySessionRow } from "../api/types.ts";
import { buildSidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export function projectSidebarSession(
  row: Partial<GatewaySessionRow>,
  selfUserId?: string,
): SidebarRecentSession {
  const context = {
    basePath: "",
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "main" } },
    gateway: {
      snapshot: {
        assistantAgentId: "main",
        hello: null,
        selfUser: selfUserId ? { id: selfUserId } : undefined,
      },
    },
    sessions: {
      isPreparedWorkSession: () => false,
      pullRequestSummary: () => undefined,
    },
  } as unknown as Parameters<typeof buildSidebarSessionNavigationState>[0]["context"];
  const navigation = buildSidebarSessionNavigationState({
    context,
    routeSessionKey: "agent:main:main",
    sessionsResult: null,
    sessionsAgentId: null,
    showCron: false,
    showSystem: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: false,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxAttentionCountForSessionKey: () => 0,
    hasSessionDraft: () => false,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });
  return navigation.toSidebarSession({
    key: "agent:main:draft",
    kind: "direct",
    updatedAt: 1,
    ...row,
  });
}
