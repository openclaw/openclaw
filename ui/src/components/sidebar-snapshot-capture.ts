import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { isHomePanelAvailable } from "../app/panel-availability.ts";
import { loadSettings } from "../app/settings.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { presenceViewerLastActivity, profilePresenceViewer } from "../lib/presence-users.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import type { SessionCreatedActor } from "../lib/session-owner.ts";
import { readSidebarBrandPresentation, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { hasSidebarListFilter } from "./session-data-events.ts";
import { sidebarSessionBadgeFacts } from "./session-row-badge-presentation.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import { resolveSidebarOnline } from "./sidebar-online-state.ts";
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
    (Boolean(host.sessionData.sessionListError ?? sessions.state.error) ||
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
  if (
    host.navigationView === "online" &&
    host.navigationVisible &&
    !host.navigationCollapsed &&
    resolveSidebarOnline(host).users.some((person) => person.identity?.type === "profile") &&
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
    host.sessionData.sessionListError !== null ||
    context.sessions.state.error !== null ||
    (host.navigationView === "online" && host.sessionData.ownerCounts.error !== null) ||
    (host.sidebarAgentsMode === "roster" && roster.error !== null) ||
    (context.plugins.registryStatus !== "complete" && !host.sidebarPluginSnapshot)
  ) {
    return null;
  }
  const online = resolveSidebarOnline(host);
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
  const displayPerson = <T extends SessionCreatedActor | SessionParticipant>(person: T): T => {
    const identity = person.identity;
    const avatarUrl =
      identity?.type === "agent"
        ? (resolveAgentAvatarUrl(
            agents.agents.find((agent) => agent.id === identity.id) ?? {},
            context.agentIdentity.get(identity.id),
          ) ?? undefined)
        : profileDirectory(context.gateway).avatarIdentity({
            identity,
            profileAvatarUrl: person.avatarUrl,
          }).profileAvatarUrl;
    return { ...person, avatarUrl };
  };
  const presentation = (row: SidebarRecentSession) => ({
    owner: row.owner && { ...row.owner, actor: displayPerson(row.owner.actor) },
    archivedBy: row.archivedBy && displayPerson(row.archivedBy),
    participants: row.participants?.map(displayPerson),
    childrenDisplayMode: host.sessionProjection.children.capture(row.key),
    snapshotSubtitle: row.snapshot
      ? row.snapshotSubtitle
      : resolveSidebarSessionRowSubtitle(host, row),
    state: sidebarSessionBadgeFacts(host.sessionPullRequests, row),
  });
  const home = host.visibleHomeSession(host.expandedAgentId());
  return parseSidebarSnapshot({
    routingDefaults: {
      mainKey: agents.mainKey,
      scope: agents.scope,
    },
    // The read receipt is not a display change.
    roster: { ...bootRoster, result: { ...bootRoster.result, ts: 0 } },
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
      return (
        entry?.type !== "session" ||
        (!isIncognitoSessionKey(entry.key) && !context.sessions.deletionState(entry.key))
      );
    }),
    issuesCount: snapshotIssuesCount(context.sidebarAttention.entries),
    ...snapshotSections(sections, host.collapsedSessionSections, presentation),
    cards: roster.cards,
    collapsedAgentIds:
      loadSettings(context.gateway.connection.gatewayUrl).sidebarCollapsedAgentIds ?? [],
    plugins,
    onlineUsers: online.users.map((user) => ({
      ...displayUser(user),
      watchedSessions: user.watchedSessions.filter(
        (key) => zone.sessionRows.has(key) && !isIncognitoSessionKey(key),
      ),
      entries: [{ ts: 0, lastActivityAt: presenceViewerLastActivity(user) }],
    })),
    onlineCounts: [...(online.counts ?? [])],
    peopleSortMode: host.people.sortMode,
    peopleStatusFilter: host.people.statusFilter,
    peoplePresenceFilter: host.people.presenceFilter,
    offlineUsers: (host.peopleView?.directory()?.result?.profiles ?? [])
      .filter((profile) => !profile.mergedInto)
      .map(profilePresenceViewer),
    ownerId: host.sessionOwnerFilterId,
    involvingMe: host.sessionInvolvingMeFilterActive,
    home: snapshotSessions(home ? [home] : [], presentation)[0] ?? null,
    homeAllowed: isHomePanelAvailable(context.gateway),
    homeSessionKey: host.selectedAgentMainSessionKey(host.expandedAgentId()),
    ownershipAvatars: host.sessionOwnershipVisibility.avatars,
    newSessionAllowed: host.readNewSessionAccess().allowed,
    windowKeys: [...host.mountedPresence().sessionKeys].filter(
      (key) => !isIncognitoSessionKey(key),
    ),
    scrollTop: host.scroll?.element()?.scrollTop ?? 0,
    footer: displayUser(context.gateway.snapshot.selfUser),
    brand: readSidebarBrandPresentation(host),
  });
}
