import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { presenceViewerLastActivity, profilePresenceViewer } from "../lib/presence-users.ts";
import { readSidebarBrandPresentation, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { hasSidebarListFilter } from "./session-data-events.ts";
import { sidebarSessionBadgeFacts } from "./session-row-badge-presentation.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import { resolveSidebarOnline, sidebarOnlineOrder } from "./sidebar-online-state.ts";
import {
  parseSidebarSnapshot,
  snapshotSections,
  snapshotSessions,
  snapshotIssuesCount,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";

function displayUser(user: AuthenticatedUser | null | undefined) {
  return user
    ? {
        ...user,
        identity: user.identity?.type === "profile" ? user.identity : undefined,
      }
    : null;
}

export function isSidebarSnapshotSettled(host: AppSidebarRenderHost): boolean {
  const context = host.sessionDataContext;
  if (!host.connected || !context) {
    return false;
  }
  if (host.navigationView === "pages") {
    const pages = host.navigationCatalog.dashboards;
    return pages?.loading === false && (pages.readSucceeded === true || pages.error !== null);
  }
  const sessions = context.sessions;
  const rootsSettled =
    !sessions.state.loading &&
    (Boolean(host.sessionData.sessionMutationError ?? sessions.state.error) ||
      (sessions.canonicalListReady &&
        Boolean(sessions.presentation.result) &&
        !sessions.presentation.resultCached));
  if (host.navigationView === "sessions" && !rootsSettled) {
    return false;
  }
  if (
    host.sessionData.sessionLineageVisible &&
    [...host.childSessionParents()].some(
      (key) =>
        host.sessionData.loadingChildSessionKeys.has(key) ||
        (!host.sessionData.loadedChildSessionKeys.has(key) &&
          !host.sessionData.childSessionErrorsByParent.has(key)),
    )
  ) {
    return false;
  }
  const people = resolveSidebarOnline(host).users;
  if (
    people.some((person) => person.identity?.type === "profile") &&
    host.sessionData.ownerCounts.counts === null &&
    host.sessionData.ownerCounts.error === null
  ) {
    return false;
  }
  if (host.sidebarAgentsMode === "roster") {
    const roster = rosterActivityStore(context).snapshot;
    return (
      (roster.membershipReady || roster.error !== null) &&
      !roster.loading &&
      roster.involvingMe === host.sidebarSessionOwnerFilter().involvingMe
    );
  }
  if (hasSidebarListFilter(host)) {
    const query = host.sessionData.sessionListQuery(host.expandedAgentId());
    const selected = context.sessions.listSnapshot(query);
    return !selected.loading && (selected.readSucceeded === true || selected.error !== null);
  }
  return rootsSettled && !host.sessionData.sessionsLoading;
}

export function captureSidebarSnapshotModel(
  host: AppSidebarRenderHost,
  context: ApplicationContext,
  rows: SidebarRecentSession[],
  sections: SidebarVisibleSections["sections"],
): SidebarSnapshotModel | null {
  const bootRoster = context.sessions.captureBootRoster();
  const agents = context.agents.state.agentsList;
  if (!bootRoster || !agents) {
    return null;
  }
  const zone = host.reconciledSidebarZone(rows);
  const roster = rosterActivityStore(context).snapshot;
  if (
    host.sidebarSnapshot ||
    (host.navigationView === "pages" &&
      host.navigationCatalog.dashboards?.readSucceeded !== true) ||
    host.sessionData.sessionMutationError !== null ||
    context.sessions.state.error !== null ||
    host.sessionData.ownerCounts.error !== null ||
    (host.sidebarAgentsMode === "roster" && roster.error !== null) ||
    (context.plugins.registryStatus !== "complete" && !host.sidebarPluginSnapshot)
  ) {
    return null;
  }
  const online = sidebarOnlineOrder(host);
  const plugins = [...zone.pluginTabs].map(([key, tab]) => ({
    key,
    pluginId: tab.pluginId,
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
  }));
  for (const { key, pluginId, value } of host.pluginNavigation()) {
    plugins.push({ key, pluginId, id: value.page.id, label: value.label, icon: value.icon });
  }
  const presentation = (row: SidebarRecentSession) => ({
    childrenDisplayMode: host.sessionProjection.children.capture(row.key),
    snapshotSubtitle: row.snapshot
      ? row.snapshotSubtitle
      : resolveSidebarSessionRowSubtitle(host, row),
    state: sidebarSessionBadgeFacts(host.sessionPullRequests, row),
  });
  return parseSidebarSnapshot({
    routingDefaults: {
      mainKey: agents.mainKey,
      scope: agents.scope,
    },
    roster: bootRoster,
    mode: host.sidebarAgentsMode,
    grouping: host.effectiveSessionsGrouping(),
    navigationView: host.navigationView,
    pages: snapshotSessions(
      (host.navigationCatalog.dashboards?.result?.sessions ?? []).map((row) =>
        host.getSessionNavigationState().toSidebarSession(row),
      ),
      presentation,
    ),
    pageScopeId: context.agentSelection.state.scopeId,
    pinnedSessions: snapshotSessions(
      zone.sidebarEntries.flatMap((value) => {
        const entry = parseSidebarEntry(value);
        const row = entry?.type === "session" ? zone.sessionRows.get(entry.key) : undefined;
        return row ? [row] : [];
      }),
      presentation,
    ),
    entries: zone.sidebarEntries.filter((value) => {
      const entry = parseSidebarEntry(value);
      return entry?.type !== "session" || !isIncognitoSessionKey(entry.key);
    }),
    issuesCount: snapshotIssuesCount(context.sidebarAttention.entries),
    ...snapshotSections(sections, host.collapsedSessionSections, presentation),
    cards: roster.cards,
    collapsedAgentIds:
      loadSettings(context.gateway.connection.gatewayUrl).sidebarCollapsedAgentIds ?? [],
    plugins,
    onlineUsers: online.users.map((user) => {
      const lastActivityAt = presenceViewerLastActivity(user);
      return {
        ...displayUser(user),
        watchedSessions: [],
        entries: [{ ts: 0, lastActivityAt }],
      };
    }),
    onlineCounts: [...(online.counts ?? [])],
    peopleSortMode: host.people.sortMode,
    peopleStatusFilter: host.people.statusFilter,
    peoplePresenceFilter: host.people.presenceFilter,
    offlineUsers: (host.peopleView?.directory()?.result?.profiles ?? [])
      .filter((profile) => !profile.mergedInto)
      .map(profilePresenceViewer),
    ownerId: host.sessionOwnerFilterId,
    involvingMe: host.sessionInvolvingMeFilterActive,
    footer: displayUser(context.gateway.snapshot.selfUser),
    brand: readSidebarBrandPresentation(host),
  });
}
