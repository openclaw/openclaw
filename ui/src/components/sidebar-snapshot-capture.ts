import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import type { IdentityAvatarInput } from "../lib/identity-avatar.ts";
import {
  presenceViewerLastActivity,
  profilePresenceViewer,
  projectPresenceViewers,
} from "../lib/presence-users.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import type { SessionCreatedActor } from "../lib/session-owner.ts";
import { readSidebarBrandPresentation, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionAttentionIconName } from "./session-attention-presentation.ts";
import { hasSidebarListFilter } from "./session-data-events.ts";
import { sessionLeadingRun, sessionLeadingAvatarIdentities } from "./session-leading-indicator.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import { resolveSidebarOnline, sidebarOnlineOrder } from "./sidebar-online-state.ts";
import { sidebarInboxTabCounts } from "./sidebar-attention-entries.ts";
import { sidebarSessionOwnerPresentation } from "./sidebar-session-owner-presentation.ts";
import {
  parseSidebarSnapshot,
  createSidebarSnapshotRows,
  snapshotSections,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";
import { summarizeTeamSessionSlots } from "./solid/session-presentation.tsx";

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
  const directory = profileDirectory(context.gateway);
  const avatar = (input: IdentityAvatarInput) => directory.avatarIdentity(input).profileAvatarUrl;
  const displayUser = (user: AuthenticatedUser) => ({
    ...user,
    avatarUrl: avatar({ ...user, profileAvatarUrl: user.avatarUrl }),
    identity: user.identity?.type === "profile" ? user.identity : undefined,
  });
  const displayActor = (actor: SessionCreatedActor | null) =>
    actor
      ? {
          ...actor,
          avatarUrl: avatar({
            id: actor.id,
            identity: actor.identity,
            name: actor.label,
            profileAvatarUrl: actor.avatarUrl,
          }),
        }
      : null;
  const snapshot = createSidebarSnapshotRows((row: SidebarRecentSession) => {
    const owner = sidebarSessionOwnerPresentation(host, row);
    const attention = row.ownAttention ?? row.attention;
    const slots = summarizeTeamSessionSlots([row], !host.isSessionChildrenExpanded(row));
    const run = sessionLeadingRun(row, host.sidebarAgentsMode !== "roster");
    const tone = (host.sidebarAgentsMode === "roster" ? attention : row.attention).kind;
    const viewers = projectPresenceViewers(
      host.sessionData.presencePayload,
      context.gateway.snapshot.selfUser,
      host.sessionData.presenceInstanceId,
      row.key,
      sessionLeadingAvatarIdentities(
        row,
        owner.owner,
        Boolean(row.icon) || (host.sidebarAgentsMode !== "roster" && row.attention.kind !== "none"),
        host.sidebarAgentsMode === "roster",
      ),
    );
    return {
      attention:
        row.attention.kind === "none"
          ? undefined
          : [row.attention.kind, sessionAttentionIconName(row.attention)],
      tone: tone === "none" ? undefined : tone,
      run: run === "none" ? undefined : run,
      slotAttention:
        slots.attention.kind === "none"
          ? undefined
          : [slots.attention.kind, sessionAttentionIconName(slots.attention)],
      slotActive: slots.active || undefined,
      slotQueued: slots.queued || undefined,
      slotUnread: slots.unread || undefined,
      slotFailed: slots.failed || undefined,
      childrenDisplayMode: host.sessionProjection.children.capture(row.key),
      snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
      participants:
        (row.participantCount ?? row.participants?.length) === 1
          ? row.participants?.slice(0, 1).map((person) => ({
              ...person,
              avatarUrl: avatar({
                identity: person.identity,
                name: person.label,
                profileAvatarUrl: person.avatarUrl,
              }),
            }))
          : undefined,
      ...owner,
      owner: displayActor(owner.owner),
      viewerCount: viewers.length > 3 ? viewers.length : undefined,
      viewers: viewers.slice(0, 3).map((user) => ({ ...displayUser(user), watchedSessions: [] })),
      pullRequest: host.sessionPullRequests.summary(row.key, row.worktreeId ?? "", row.pullRequest),
      pullRequestCount: host.sessionPullRequests.count(row.key),
      hasApproval:
        (attention.kind === "question"
          ? attention.requests.some((request) => request.kind === "approval")
          : host.sidebarAgentsMode !== "roster" && attention.kind === "approval") || undefined,
    };
  }, bootRoster);
  const visible = snapshotSections(sections, host.collapsedSessionSections, snapshot.capture);
  return parseSidebarSnapshot({
    rows: snapshot.rows,
    avatarAgents: agents.agents.slice(0, 128).map((agent) => {
      const identity = context.agentIdentity.get(agent.id);
      return {
        id: agent.id,
        name: normalizeAgentLabel(agent, identity),
        avatar: resolveAgentAvatarUrl(agent, identity),
        textAvatar: resolveAgentTextAvatar(agent, identity),
      };
    }),
    ownerOptions: host.sessionOwnershipVisibility.filters ? host.sessionOwnerOptions : [],
    issues: {
      visible: host.connected || context.sidebarAttention.entries.length > 0,
      count: sidebarInboxTabCounts(context.sidebarAttention.entries).all,
    },
    routingDefaults: {
      mainKey: agents.mainKey,
      scope: agents.scope,
    },
    roster: bootRoster,
    mode: host.sidebarAgentsMode,
    navigationView: host.navigationView,
    pages: snapshot.capture(
      (host.navigationView === "pages"
        ? (host.navigationCatalog.dashboards?.result?.sessions ?? [])
        : []
      ).map((row) => host.getSessionNavigationState().toSidebarSession(row)),
    ),
    pageScopeId: context.agentSelection.state.scopeId,
    pinnedSessions: snapshot.capture(
      zone.sidebarEntries.flatMap((value) => {
        const entry = parseSidebarEntry(value);
        const row = entry?.type === "session" ? zone.sessionRows.get(entry.key) : undefined;
        return row ? [row] : [];
      }),
    ),
    entries: zone.sidebarEntries.filter((value) => {
      const entry = parseSidebarEntry(value);
      return entry?.type !== "session" || !isIncognitoSessionKey(entry.key);
    }),
    sessions: [...new Set(visible.sections.flatMap((section) => section.rows))],
    ...visible,
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
    footer: context.gateway.snapshot.selfUser
      ? displayUser(context.gateway.snapshot.selfUser)
      : null,
    brand: readSidebarBrandPresentation(host),
  });
}
