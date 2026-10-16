import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { presenceViewerLastActivity, profilePresenceViewer } from "../lib/presence-users.ts";
import { resolveSidebarOnline, sidebarOnlineOrder } from "./app-sidebar-online.tsx";
import { readSidebarBrandPresentation, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import {
  snapshotSections,
  snapshotSessions,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";

function displayUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    identity:
      user.identity?.type === "profile"
        ? { type: "profile" as const, id: user.identity.id }
        : undefined,
  };
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
  return (
    !host.sessionData.sessionsLoading &&
    (Boolean(host.sessionData.sessionMutationError ?? context.sessions.state.error) ||
      (Boolean(host.sessionData.sessionsResult) && !context.sessions.presentation.resultCached))
  );
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
    snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
  });
  const sessions = snapshotSessions(rows, presentation);
  return {
    routingDefaults: {
      mainKey: agents.mainKey,
      scope: agents.scope,
    },
    roster: {
      agentId: bootRoster.agentId,
      groups: [...bootRoster.groups],
      groupSettings: bootRoster.groupSettings.map(({ name, position }) => ({ name, position })),
      sectionOrder: [...bootRoster.sectionOrder],
      result: {
        ts: bootRoster.result.ts,
        path: bootRoster.result.path,
        count: bootRoster.result.count,
        defaults: {
          model: bootRoster.result.defaults.model,
          modelProvider: bootRoster.result.defaults.modelProvider,
          contextTokens: bootRoster.result.defaults.contextTokens,
        },
        sessions: bootRoster.result.sessions.map((row) => ({
          key: row.key,
          kind: row.kind,
          sessionId: row.sessionId,
          agentId: row.agentId,
          label: row.label,
          autoLabel: row.autoLabel,
          icon: row.icon,
          color: row.color,
          channel: row.channel,
          displayName: row.displayName,
          derivedTitle: row.derivedTitle,
          lastMessagePreview: row.lastMessagePreview,
          updatedAt: row.updatedAt,
          category: row.category,
          pinned: row.pinned,
          archived: row.archived,
          hasBoard: row.hasBoard,
          boardFace: row.boardFace,
          boardPresentation: row.boardPresentation,
          workspaceDir: row.workspaceDir,
          spawnedWorkspaceDir: row.spawnedWorkspaceDir,
          spawnedCwd: row.spawnedCwd,
          execNode: row.execNode,
          execCwd: row.execCwd,
          deviceFolder: row.deviceFolder
            ? { deviceId: row.deviceFolder.deviceId, path: row.deviceFolder.path }
            : undefined,
          worktree: row.worktree
            ? { id: row.worktree.id, branch: row.worktree.branch, repoRoot: row.worktree.repoRoot }
            : undefined,
          repository: row.repository
            ? { url: row.repository.url, ref: row.repository.ref, branch: row.repository.branch }
            : undefined,
          thinkingLevel: row.thinkingLevel,
          model: row.model,
          modelProvider: row.modelProvider,
          owner: row.owner
            ? {
                actor: {
                  type: row.owner.actor.type,
                  id: row.owner.actor.id,
                  label: row.owner.actor.label,
                },
              }
            : undefined,
        })),
      },
    },
    mode: host.sidebarAgentsMode,
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
    sessions,
    ...snapshotSections(sections, host.collapsedSessionSections, presentation),
    cards: roster.cards.map(({ id, name, mainKey, avatar, textAvatar, role, model }) => ({
      id,
      name,
      mainKey,
      avatar,
      textAvatar,
      role,
      model,
    })),
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
      .map((profile) =>
        Object.assign(displayUser(profilePresenceViewer(profile)), {
          watchedSessions: [],
          entries: [],
        }),
      ),
    ownerId: host.sessionOwnerFilterId,
    involvingMe: host.sessionInvolvingMeFilterActive,
    footer: context.gateway.snapshot.selfUser
      ? displayUser(context.gateway.snapshot.selfUser)
      : null,
    brand: readSidebarBrandPresentation(host),
  };
}
