import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import type { createStoredChatOutboxReader } from "../lib/chat/outbox-store-projection.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { projectSidebarHomeSession } from "./app-sidebar-agent-session-rows.ts";
import {
  projectSidebarSessionCatalogs,
  type SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import { findActiveSidebarLineageRow } from "./app-sidebar-session-lookup.ts";
import {
  buildSidebarSessionNavigationState,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import type {
  SidebarSessionProjection,
  SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import type {
  SidebarEmptyGroupsMode,
  SidebarRecentSession,
  SidebarSessionSortMode,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export type SidebarProjectionHost = {
  readonly sessionData: SessionDataController;
  readonly sessionDataContext: ApplicationContext | undefined;
  readonly sessionProjection: SidebarSessionProjection;
  readonly sidebarAgentsMode: "chip" | "roster";
  readonly rosterSessionSource: {
    result: SessionsListResult | null;
    agentIds: readonly string[];
    collapsedAgentIds: ReadonlySet<string>;
  } | null;
  readonly activeRouteId?: RouteId;
  readonly sessionSortMode: SidebarSessionSortMode;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionsEmptyGroupsMode: SidebarEmptyGroupsMode;
  readonly sessionsShowCron: boolean;
  readonly sessionsShowSystem: boolean;
  readonly sessionsShowPreview: boolean;
  readonly sidebarLiveActivity: boolean;
  readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  readonly collapsedSessionSections: ReadonlySet<string>;
  readonly hiddenSessionCatalogIds: ReadonlySet<string>;
  readonly sessionOwnerFilterId: string | null;
  readonly sessionOwnerFilterActive: boolean;
  readonly sessionInvolvingMeFilterActive: boolean;
  readonly storedOutboxes:
    | ReturnType<ReturnType<typeof createStoredChatOutboxReader>["read"]>
    | undefined;
  resolveSessionAttention: Parameters<typeof projectSidebarHomeSession>[0]["resolveAttention"];
  getRouteSessionKey(): string;
  getSessionNavigationState(): SidebarSessionNavigationState;
  effectiveSessionSortMode(): SidebarSessionSortMode;
  effectiveSessionsGrouping(): SidebarSessionsGrouping;
  expandedAgentId(): string;
  sessionNavigationAgentId(session: Pick<SidebarRecentSession, "key" | "agentId">): string;
  selectedAgentMainSessionKey(agentId: string): string;
  knownSessionGroups(): string[];
  knownSectionOrder(): string[];
  visibleSessionCatalogs(): SessionDataController["sessionCatalogs"];
};

/** Slot identities belong to the publishing owners; projection never compares row contents. */
export class SidebarProjectionMemo<T> {
  private slots: readonly unknown[] | undefined;
  private value!: T;

  read(inputs: () => readonly unknown[], project: () => T): T {
    const slots = inputs();
    if (
      !this.slots ||
      slots.length !== this.slots.length ||
      slots.some((slot, index) => !Object.is(slot, this.slots![index]))
    ) {
      this.value = project();
      // Stateful projection may publish created order, membership, or subtitles.
      this.slots = inputs();
    }
    return this.value;
  }
}

export function sidebarNavigationInputs(
  host: SidebarProjectionHost,
  result: SessionsListResult | null,
) {
  const data = host.sessionData;
  const context = host.sessionDataContext;
  return [
    context,
    result,
    Boolean(host.sidebarAgentsMode === "roster" && host.rosterSessionSource),
    data.sessionsAgentId,
    data.sessionResultsByAgent,
    data.activeSessionLineageRoot,
    data.activeSessionLineageSelectedRow,
    data.childSessionRowsByParent,
    data.loadingChildSessionKeys,
    host.getRouteSessionKey(),
    isSessionRouteId(host.activeRouteId),
    context?.agentSelection.state.selectedId,
    context?.gateway.snapshot.assistantAgentId,
    context?.agents.state.agentsList,
    context?.gateway.snapshot.hello,
    context?.gateway.snapshot.selfUser?.id,
    context?.sessions,
    context?.sessions.revision,
    host.sessionSortMode,
    host.sessionProjection.createdOrderRevision,
    host.sessionsShowCron,
    host.sessionsShowSystem,
    host.sessionsStatusFilter,
    host.resolveSessionAttention,
    host.storedOutboxes,
    i18n.getLocale(),
  ];
}

export function memoizedSidebarSections(
  memo: SidebarProjectionMemo<SidebarVisibleSections>,
  host: SidebarProjectionHost,
  rows: SidebarRecentSession[],
  catalogs: SidebarSessionCatalog[],
  rosterLimits: ReadonlyMap<string, number>,
): SidebarVisibleSections {
  const context = host.sessionDataContext;
  const roster = host.sidebarAgentsMode === "roster" ? host.rosterSessionSource : null;
  return memo.read(
    () => [
      rows,
      catalogs,
      roster,
      host.collapsedSessionSections,
      host.effectiveSessionsGrouping(),
      host.sessionsEmptyGroupsMode,
      rosterLimits,
      host.sessionData.visibleSessionLimits,
      context?.gateway.snapshot.phase,
      context?.gateway.snapshot.client,
      host.sidebarLiveActivity,
      host.sessionsShowPreview,
      host.sidebarNarrationLines,
      host.sidebarObserverDigests,
      host.sessionProjection.revision,
    ],
    () => {
      const grouping = host.effectiveSessionsGrouping();
      const sections = roster?.agentIds.map((agentId) => ({
        id: `agent:${agentId}:recent` as const,
        rows: rows.filter((row) => !row.pinned && host.sessionNavigationAgentId(row) === agentId),
      }));
      const collapsedSections = new Set(host.collapsedSessionSections);
      for (const agentId of roster?.collapsedAgentIds ?? []) {
        collapsedSections.add(`agent:${agentId}:recent`);
      }
      return host.sessionProjection.project({
        rows,
        sections,
        grouping,
        knownGroups: grouping === "category" ? host.knownSessionGroups() : [],
        selfOwnerId: context?.gateway.snapshot.selfUser?.id ?? null,
        // Normalize gateway order without dropping catalog-lagging categories.
        sectionOrder: host.knownSectionOrder(),
        catalogIds: catalogs.map((catalog) => catalog.id),
        collapsedSections,
        emptyGroupsMode: host.sessionsEmptyGroupsMode,
        ownerFiltered: host.sessionOwnerFilterActive || host.sessionInvolvingMeFilterActive,
        visibleSessionLimits: roster ? rosterLimits : host.sessionData.visibleSessionLimits,
        sortMode: host.effectiveSessionSortMode(),
        statusFilter: host.sessionsStatusFilter,
        agentId: roster ? "*" : host.expandedAgentId(),
        connectionIdentity:
          context?.gateway.snapshot.phase === "connected"
            ? (context.gateway.snapshot.client ?? null)
            : null,
        listSource: context?.sessions ?? null,
        subtitle: {
          sidebarLiveActivity: host.sidebarLiveActivity,
          showPreview: host.sessionsShowPreview,
          narrationLines: host.sidebarNarrationLines,
          observerDigests: host.sidebarObserverDigests,
        },
      });
    },
  );
}

export function projectSidebarNavigation(
  host: SidebarProjectionHost,
  compareSessions: (a: GatewaySessionRow, b: GatewaySessionRow) => number,
  runtimeSampledAtByRow: WeakMap<GatewaySessionRow, number>,
  resolveAgentStatusNote: (row: GatewaySessionRow) => string | undefined,
) {
  const roster = host.sidebarAgentsMode === "roster" ? host.rosterSessionSource : null;
  const routeSessionKey = host.getRouteSessionKey();
  const navigation = buildSidebarSessionNavigationState({
    context: host.sessionDataContext,
    routeSessionKey,
    sessionsResult: roster?.result ?? host.sessionData.sessionsResult,
    activeSession: findActiveSidebarLineageRow(host.sessionData, routeSessionKey),
    sessionsAgentId: host.sessionData.sessionsAgentId,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
    statusFilter: host.sessionsStatusFilter,
    compareSessions,
    highlightCurrentSession: isSessionRouteId(host.activeRouteId),
    runtimeSampledAtByRow,
    loadingChildSessionKeys: host.sessionData.loadingChildSessionKeys,
    outboxAttentionCountForSessionKey: (key) =>
      host.storedOutboxes?.attentionCountForSession(key) ?? 0,
    hasSessionDraft: (key) => host.storedOutboxes?.hasSessionDraft(key) ?? false,
    resolveAttention: host.resolveSessionAttention,
    resolveAgentStatusNote,
  });
  if (roster) {
    const rows = roster.result?.sessions ?? [];
    const current = navigation.visibleSessionRows.find(
      (row) => row.key === navigation.activeRowKey,
    );
    navigation.visibleSessionRows =
      current && !rows.some((row) => row.key === current.key) ? [...rows, current] : [...rows];
  }
  return navigation;
}

export function memoizedSidebarCatalogs(
  memo: SidebarProjectionMemo<SidebarSessionCatalog[]>,
  host: SidebarProjectionHost,
  ownerId: string | null,
  liveRows: () => GatewaySessionRow[],
) {
  return memo.read(
    () => [
      host.sessionData.sessionCatalogs,
      host.sessionData.pendingCatalogArchives,
      host.hiddenSessionCatalogIds,
      host.sessionsStatusFilter,
      ownerId,
      host.sessionData.sessionsResult,
      host.sessionData.sessionResultsByAgent,
    ],
    () => projectSidebarSessionCatalogs(host.visibleSessionCatalogs(), ownerId, liveRows()),
  );
}

export function sidebarRowsInputs(
  host: SidebarProjectionHost,
  navigationState: SidebarSessionNavigationState,
) {
  const data = host.sessionData;
  // List only inputs not already keyed by the upstream stage value.
  return [
    navigationState,
    host.sidebarAgentsMode === "roster" ? host.rosterSessionSource : null,
    host.expandedAgentId(),
    data.sessionsResult,
    data.loadedChildSessionKeys,
    data.childSessionErrorsByParent,
    data.sessionCatalogs,
    data.pendingCatalogArchives,
    host.hiddenSessionCatalogIds,
    host.sessionOwnerFilterId,
    host.sessionInvolvingMeFilterActive,
    host.sessionDataContext?.gateway.snapshot.selfUser,
  ];
}

export function memoizedSidebarHome(
  memo: SidebarProjectionMemo<SidebarRecentSession>,
  host: SidebarProjectionHost,
  row: GatewaySessionRow,
  agentId: string,
) {
  const result = host.sidebarAgentsMode === "roster" ? host.rosterSessionSource?.result : undefined;
  const navigationState = host.getSessionNavigationState();
  return memo.read(
    () => [
      row,
      agentId,
      result,
      navigationState,
      host.sessionData.loadedChildSessionKeys,
      host.sessionData.childSessionErrorsByParent,
    ],
    () =>
      projectSidebarHomeSession({
        host,
        row,
        agentId,
        result,
        navigationState,
        resolveAttention: host.resolveSessionAttention,
      }),
  );
}
