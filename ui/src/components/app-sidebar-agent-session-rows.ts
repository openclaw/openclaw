import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { filterVisibleSessionRows, sessionMatchesArchivedFilter } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../lib/sessions/session-key.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import {
  collectCategorizedChildRootRows,
  collectSidebarSessionRowsByKey,
  someSidebarSessionInTree,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import {
  collectPromotedMainChildRows,
  collectSidebarSessionChildKeys,
} from "./app-sidebar-session-parent.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import type {
  SidebarKnownSessionAttention,
  SidebarRecentSession,
  SidebarSessionStatusFilter,
  SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

type AgentSessionRowsHost = {
  readonly sessionDataContext:
    | Pick<ApplicationContext, "agents" | "gateway" | "sessions">
    | undefined;
  readonly sessionData: SessionDataController;
  visibleSessionCatalogs(): readonly SessionCatalog[];
  selectedAgentMainSessionKey(agentId: string): string;
  readonly sessionsShowCron: boolean;
  readonly sessionsShowSystem: boolean;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionInvolvingMeFilterActive: boolean;
};

/** Project either sidebar scope through one sorted session forest. */
export function projectSidebarAgentSessionRows({
  host,
  navigationState,
  selected,
  agentIds,
  result,
  compareSessions,
  knownSessionAttention,
}: {
  host: AgentSessionRowsHost;
  navigationState: SidebarSessionNavigationState;
  selected: string;
  agentIds: readonly string[];
  result?: SessionsListResult | null;
  compareSessions: (a: GatewaySessionRow, b: GatewaySessionRow) => number;
  knownSessionAttention: readonly SidebarKnownSessionAttention[];
}): SidebarRecentSession[] {
  const grouped = result !== undefined;
  const defaultAgentId = resolveUiDefaultAgentId({
    agentsList: host.sessionDataContext?.agents.state.agentsList,
    hello: host.sessionDataContext?.gateway.snapshot.hello,
  });
  const allowedAgents = new Set(agentIds);
  const inScope = (row: GatewaySessionRow) =>
    !grouped || allowedAgents.has(resolveUiSessionRowAgentId(row, defaultAgentId));
  const lineageRoot = host.sessionData.activeSessionLineageRoot;
  const knownRows = grouped
    ? collectSidebarSessionRowsByKey({
        rows: [...(lineageRoot ? [lineageRoot] : []), ...navigationState.visibleSessionRows],
        childRowsByParent: host.sessionData.childSessionRowsByParent,
      })
    : null;
  const adopted = grouped
    ? new Set<string>()
    : adoptedCatalogSessionKeys(host.visibleSessionCatalogs());
  const loadedAgentId = normalizeAgentId(host.sessionData.sessionsAgentId ?? "");
  const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
  const visibilityOptions = {
    agentId: selected,
    defaultAgentId,
    filterByAgent: !grouped,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
    archivedFilter: host.sessionsStatusFilter,
  } as const;
  const { childSessionRowsByParent, isSessionHidden, rows } = projectSidebarArchiveVisibility({
    sessionData: grouped
      ? {
          sessionsAgentId: selected,
          sessionsResult: result,
          sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
          childSessionRowsByParent: host.sessionData.childSessionRowsByParent,
        }
      : host.sessionData,
    selectedAgentId: selected,
    statusFilter: host.sessionsStatusFilter,
    deletionState: (key, agentId) =>
      host.sessionDataContext?.sessions.deletionState(
        key,
        grouped
          ? resolveUiSessionRowAgentId(knownRows?.get(key) ?? { key }, defaultAgentId)
          : agentId,
      ),
    archiveVisibility: (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
  });
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const sessionRowsByKey = collectSidebarSessionRowsByKey({
    rows,
    childRowsByParent: childSessionRowsByParent,
  });
  // Home belongs to its navigation entry (the agent header in team mode), never a session row.
  const canonicalMainKeys = agentIds.map((agentId) => host.selectedAgentMainSessionKey(agentId));
  const isMainSession = (key: string) =>
    canonicalMainKeys.some((mainKey) => areUiSessionKeysEquivalent(key, mainKey));
  const rootRows =
    !grouped && selected === routeAgentId && selected === loadedAgentId
      ? navigationState.visibleSessionRows.flatMap((session) => {
          const row = rowsByKey.get(session.key);
          return row ? [row] : [];
        })
      : filterVisibleSessionRows(rows.filter(inScope), visibilityOptions).toSorted(compareSessions);
  const lineageAgentId = normalizeAgentId(
    parseAgentSessionKey(lineageRoot?.key ?? "")?.agentId ?? "",
  );
  // Adopted catalog keys render as live rows inside the Coding catalog;
  // re-inserting one here would show the selected session twice.
  const selectedFallback = navigationState.visibleSessionRows.find(
    (session) =>
      (grouped ? inScope(session) : selected === routeAgentId || lineageAgentId === selected) &&
      session.key === navigationState.activeRowKey &&
      !isSessionHidden(session) &&
      !adopted.has(session.key) &&
      !isMainSession(session.key),
  );
  const mainSessionKeys = new Set(canonicalMainKeys);
  const scopedRootRows = rootRows.filter((row) => !isMainSession(row.key));
  const lineageRouteAgentId = normalizeAgentId(
    parseAgentSessionKey(navigationState.routeSessionKey)?.agentId ?? "",
  );
  if (
    lineageRoot &&
    !isSessionHidden(lineageRoot) &&
    (areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey) ||
      sessionMatchesArchivedFilter(lineageRoot, host.sessionsStatusFilter)) &&
    (grouped
      ? inScope(lineageRoot)
      : lineageAgentId === selected || lineageRouteAgentId === selected) &&
    !adopted.has(lineageRoot.key) &&
    !isMainSession(lineageRoot.key) &&
    !scopedRootRows.some((row) => row.key === lineageRoot.key)
  ) {
    scopedRootRows.push(lineageRoot);
  }
  // The shared window includes archives; supplemental child loads must obey
  // the same status and Gateway-owned involvement membership as group roots.
  const visibleRowsByKey = new Map(
    [...sessionRowsByKey].filter(
      ([key, row]) =>
        !grouped ||
        (sessionMatchesArchivedFilter(row, host.sessionsStatusFilter) &&
          (!host.sessionInvolvingMeFilterActive || rowsByKey.has(key))),
    ),
  );
  // A directly opened Home can live only in the accepted lineage descriptor,
  // outside the bounded roster. Its links still own loading and child placement.
  if (
    lineageRoot &&
    isMainSession(lineageRoot.key) &&
    areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey) &&
    ![...visibleRowsByKey.keys()].some((key) => areUiSessionKeysEquivalent(key, lineageRoot.key))
  ) {
    visibleRowsByKey.set(lineageRoot.key, lineageRoot);
  }
  if (grouped) {
    // Keep the existing current-route/lineage exceptions independently of the
    // bounded shared window and its ordinary status-filtered members.
    for (const row of [...scopedRootRows, ...(selectedFallback ? [selectedFallback] : [])]) {
      visibleRowsByKey.set(row.key, row);
    }
    for (const [key, row] of visibleRowsByKey) {
      const childSessions = row.childSessions?.filter(
        (childKey) =>
          visibleRowsByKey.has(childKey) ||
          (!host.sessionInvolvingMeFilterActive && !sessionRowsByKey.has(childKey)),
      );
      if (childSessions && childSessions.length !== row.childSessions?.length) {
        visibleRowsByKey.set(key, { ...row, childSessions });
      }
    }
  }
  const currentRootKeys = new Set(
    [
      ...rowsByKey.keys(),
      ...scopedRootRows.map((row) => row.key),
      ...(selectedFallback ? [selectedFallback.key] : []),
      ...(lineageRoot &&
      areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey)
        ? [lineageRoot.key]
        : []),
    ].map(normalizeDefaultMainSessionAliasForUi),
  );
  const childKeysByParent = collectSidebarSessionChildKeys(visibleRowsByKey, mainSessionKeys);
  // Detail caches supplement the current forest, including parent-owned links,
  // rather than every Home/category root previously visited in chip mode.
  const reachableKeys = new Set(currentRootKeys);
  for (const key of reachableKeys) {
    for (const child of childKeysByParent.get(key) ?? []) {
      reachableKeys.add(normalizeDefaultMainSessionAliasForUi(child));
    }
  }
  const sessionCandidateRows = [...visibleRowsByKey.values()].filter(
    (row) =>
      inScope(row) &&
      (!grouped || reachableKeys.has(normalizeDefaultMainSessionAliasForUi(row.key))),
  );
  const categorizedChildRows = collectCategorizedChildRootRows({
    rows: sessionCandidateRows.filter((row) => !isMainSession(row.key)),
    scopedRoots: scopedRootRows,
    visibilityOptions,
  });
  scopedRootRows.push(...categorizedChildRows);
  const scopedRootKeys = new Set(scopedRootRows.map((row) => row.key));
  const promotedRows = collectPromotedMainChildRows({
    rows: sessionCandidateRows,
    childKeysByParent,
    archivedFilter: host.sessionsStatusFilter,
    mainSessionKeys,
    scopedRootKeys,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
  });
  for (const row of promotedRows) {
    if (!scopedRootKeys.has(row.key)) {
      scopedRootKeys.add(row.key);
      scopedRootRows.push(row);
    }
  }
  const orderedRootRows =
    promotedRows.length > 0 || categorizedChildRows.length > 0
      ? scopedRootRows.toSorted(compareSessions)
      : scopedRootRows;
  // `adopted` holds only catalog-bound keys (adoptedCatalogSessionKeys), not
  // fetched child rows: a catalog-adopted promoted child intentionally
  // renders as its live row inside the Coding catalog, never as a thread.
  const projected = projectSessionTree({
    mainSessionKeys,
    roots: orderedRootRows.filter(
      (row) => !adopted.has(row.key) && (!grouped || visibleRowsByKey.has(row.key)),
    ),
    rowsByKey: visibleRowsByKey,
    loadingChildKeys: host.sessionData.loadingChildSessionKeys,
    knownSessionAttention,
    toSidebarSession: navigationState.toSidebarSession,
  });
  if (
    selectedFallback &&
    !isSubagentSessionKey(selectedFallback.key) &&
    (!grouped || visibleRowsByKey.has(selectedFallback.key)) &&
    !someSidebarSessionInTree(projected, (row) => row.key === selectedFallback.key)
  ) {
    projected.unshift(navigationState.toSidebarSession(selectedFallback));
  }
  return projected;
}

/** Home navigation owns its own state; persistent child conversations own separate rows. */
export function projectSidebarHomeSession({
  host,
  row,
  agentId,
  result,
  navigationState,
  knownSessionAttention,
}: {
  host: AgentSessionRowsHost & {
    resolveHomeSessionAttention(key: string, row: GatewaySessionRow): SidebarSessionAttention;
  };
  row: GatewaySessionRow;
  agentId: string;
  result?: SessionsListResult | null;
  navigationState: SidebarSessionNavigationState;
  knownSessionAttention: readonly SidebarKnownSessionAttention[];
}): SidebarRecentSession {
  const { rows, childSessionRowsByParent } = projectSidebarArchiveVisibility({
    sessionData:
      result !== undefined
        ? {
            childSessionRowsByParent: host.sessionData.childSessionRowsByParent,
            sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
            sessionsAgentId: agentId,
            sessionsResult: result,
          }
        : host.sessionData,
    selectedAgentId: agentId,
    statusFilter: host.sessionsStatusFilter,
    deletionState: (key, owner) => host.sessionDataContext?.sessions.deletionState(key, owner),
    archiveVisibility: (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
  });
  const own = navigationState.toSidebarSession(row);
  const home = projectSessionTree({
    roots: [row],
    mainSessionKeys: new Set([row.key, host.selectedAgentMainSessionKey(agentId)]),
    rowsByKey: collectSidebarSessionRowsByKey({
      rows: [...rows, row],
      childRowsByParent: childSessionRowsByParent,
    }),
    loadingChildKeys: host.sessionData.loadingChildSessionKeys,
    knownSessionAttention,
    toSidebarSession: (session, isChild) =>
      isChild
        ? navigationState.toSidebarSession(session, true)
        : { ...own, attention: host.resolveHomeSessionAttention(row.key, row) },
  })[0]!;
  if (result === undefined) {
    return home;
  }
  // Team mode promotes persistent Home children, so the header must not count them twice.
  return {
    ...home,
    ...home.subagentSummary,
    workspaceConflictCount:
      (own.workspaceConflictCount ?? 0) + (home.subagentSummary?.workspaceConflictCount ?? 0) ||
      undefined,
  };
}
