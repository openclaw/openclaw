import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  uiConversationMatches,
} from "../lib/sessions/session-key.ts";
import { findCatalogSessionHovercardRow } from "./app-sidebar-session-catalogs.ts";
import {
  findProjectedSidebarSession,
  findSidebarSessionInTree,
  resolveLatestSidebarAgentSession,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import type {
  SidebarRecentSession,
  SidebarSessionHovercardRow,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import { sessionLineageIdentityHost } from "./session-lineage-controller.ts";

type SidebarSessionLookupData = Pick<
  SessionDataController,
  | "context"
  | "activeSessionLineageRoot"
  | "activeSessionLineageSelectedRow"
  | "childSessionRowsByParent"
  | "sessionResultsByAgent"
>;

type SidebarSessionLookupSource = {
  readonly sessionData: SidebarSessionLookupData;
  getSessionNavigationState(): SidebarSessionNavigationState;
  visibleSessionCatalogs(): readonly SessionCatalog[];
};

export function findSidebarResumeKey(
  agentId: string,
  source: {
    readonly sessionData: Parameters<typeof resolveLatestSidebarAgentSession>[0]["sessionData"];
    readonly sessionDataContext: ApplicationContext | undefined;
  },
  readMainKey: () => string,
): string {
  const latest = resolveLatestSidebarAgentSession({
    agentId,
    sessionData: source.sessionData,
    context: source.sessionDataContext,
  });
  return latest?.key ?? buildAgentMainSessionKey({ agentId, mainKey: readMainKey() });
}

export function findSidebarMainSession(
  source: {
    readonly sessionData: Pick<
      SessionDataController,
      "sessionsAgentId" | "sessionsResult" | "sessionResultsByAgent" | "activeSessionLineageRoot"
    >;
    expandedAgentId(): string;
    selectedAgentMainSessionKey(agentId: string): string;
  },
  agentId: string | undefined,
  groupedResult: SessionsListResult | null | undefined,
): GatewaySessionRow | null {
  const normalized = normalizeAgentId(agentId ?? source.expandedAgentId());
  const mainKey = source.selectedAgentMainSessionKey(normalized);
  const rows =
    groupedResult?.sessions ??
    (normalized === normalizeAgentId(source.sessionData.sessionsAgentId ?? "")
      ? (source.sessionData.sessionsResult?.sessions ?? [])
      : (source.sessionData.sessionResultsByAgent[normalized]?.sessions ?? []));
  const lineage = source.sessionData.activeSessionLineageRoot;
  return (
    (lineage ? [...rows, lineage] : rows).find((row) =>
      areUiSessionKeysEquivalent(row.key, mainKey),
    ) ?? null
  );
}

export function findActiveSidebarLineageRow(
  sessionData: SidebarSessionLookupData,
  sessionKey: string,
): GatewaySessionRow | undefined {
  return [
    sessionData.activeSessionLineageSelectedRow,
    sessionData.activeSessionLineageRoot,
    ...Object.values(sessionData.childSessionRowsByParent).flat(),
  ].find(
    (row): row is GatewaySessionRow =>
      row != null &&
      uiConversationMatches(
        sessionLineageIdentityHost(sessionData.context),
        sessionKey,
        row.key,
        row.agentId,
      ),
  );
}

export function findSidebarHovercardRow(
  source: SidebarSessionLookupSource,
  sessionKey: string,
  projectedRows: readonly SidebarRecentSession[],
): SidebarSessionHovercardRow | undefined {
  // The rendered tree owns folded descendant attention; a flat row loses it.
  const projected = findSidebarSessionInTree(projectedRows, (row) => row.key === sessionKey);
  const navigationState = source.getSessionNavigationState();
  const child = findActiveSidebarLineageRow(source.sessionData, sessionKey);
  const liveRow =
    projected ??
    findProjectedSidebarSession({
      sessionKey,
      navigationState,
      sessionResultsByAgent: source.sessionData.sessionResultsByAgent,
    }) ??
    (child ? navigationState.toSidebarSession(child, true) : undefined);
  return findCatalogSessionHovercardRow({
    catalogs: source.visibleSessionCatalogs(),
    sessionKey,
    liveRow,
  });
}

/** Merge adopted catalog sessions into the visible PR-indicator rows so an
    adopted session hidden from the regular list still surfaces its PR state. */
export function mergeAdoptedSessionPullRequestRows(input: {
  rows: SidebarRecentSession[];
  adopted: ReadonlySet<string>;
  sessionsResult: SessionsListResult | null;
  sessionResultsByAgent: Record<string, SessionsListResult>;
  navigationState: SidebarSessionNavigationState;
}): SidebarRecentSession[] {
  if (input.adopted.size === 0) {
    return input.rows;
  }
  const byKey = new Map(input.rows.map((row) => [row.key, row]));
  const liveRows = [
    ...(input.sessionsResult?.sessions ?? []),
    ...Object.values(input.sessionResultsByAgent).flatMap((result) => result.sessions),
  ];
  for (const row of liveRows) {
    if (input.adopted.has(row.key) && !byKey.has(row.key)) {
      byKey.set(row.key, input.navigationState.toSidebarSession(row));
    }
  }
  return [...byKey.values()];
}
