import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { presenceViewerLastActivity } from "../lib/presence-users.ts";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sidebarOnlineOrder } from "./app-sidebar-online.ts";
import { readSidebarBrandPresentation, type AppSidebarRenderHost } from "./app-sidebar-render.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import {
  parseSidebarSnapshot,
  snapshotSections,
  snapshotSessions,
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

export function captureSidebarSnapshotModel(
  host: AppSidebarRenderHost,
  context: ApplicationContext,
  rows: SidebarRecentSession[],
  sections: SidebarVisibleSections["sections"],
): SidebarSnapshotModel | null {
  const bootRoster = context.sessions.captureBootRoster(captureBootRoster);
  const agents = context.agents.state.agentsList;
  if (!bootRoster || !agents) {
    return null;
  }
  const zone = host.reconciledSidebarZone(rows);
  const roster = rosterActivityStore(context).snapshot;
  if (
    host.sidebarSnapshot ||
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
    childrenDisplayMode: host.sessionProjection.captureChildrenDisplay(row.key),
    snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
  });
  const sessions = snapshotSessions(rows, presentation);
  return parseSidebarSnapshot({
    routingDefaults: {
      mainKey: agents.mainKey,
      scope: agents.scope,
    },
    roster: bootRoster,
    mode: host.sidebarAgentsMode,
    navigationView: host.navigationView,
    navigationScope: host.navigationScope,
    scopesEquivalent: host.navigationCatalog.scopesEquivalent,
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
    cards: roster.cards,
    collapsedAgentIds:
      loadSettings(context.gateway.connection.gatewayUrl).sidebarCollapsedAgentIds ?? [],
    plugins,
    onlineUsers: online.users.map((user) => {
      const lastActivityAt = presenceViewerLastActivity(user);
      return {
        ...displayUser(user),
        watchedSessions: [],
        entries: lastActivityAt === undefined ? [] : [{ ts: 0, lastActivityAt }],
      };
    }),
    onlineCounts: [...(online.counts ?? [])],
    peopleSortMode: host.people.sortMode,
    peopleStatusFilter: host.people.statusFilter,
    onlineExpanded: host.teamOnlineExpanded,
    ownerId: host.sessionOwnerFilterId,
    involvingMe: host.sessionInvolvingMeFilterActive,
    footer: displayUser(context.gateway.snapshot.selfUser),
    brand: readSidebarBrandPresentation(host),
  });
}
