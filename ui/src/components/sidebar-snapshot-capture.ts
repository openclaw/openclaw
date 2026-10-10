import { parseSidebarEntry, serializeSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { presenceViewerLastActivity } from "../lib/presence-users.ts";
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

export function captureSidebarSnapshotModel(
  host: AppSidebarRenderHost,
  context: ApplicationContext,
  rows: SidebarRecentSession[],
  sections: SidebarVisibleSections["sections"],
): SidebarSnapshotModel | null {
  const zone = host.reconciledSidebarZone(rows);
  const roster = rosterActivityStore(context).snapshot;
  const online = sidebarOnlineOrder(host);
  const plugins = [...zone.pluginTabs].map(([key, tab]) => ({ key, ...tab }));
  for (const { key, pluginId, value } of host.pluginNavigation()) {
    plugins.push({ key, pluginId, id: value.page.id, label: value.label, icon: value.icon });
  }
  const presentation = (row: SidebarRecentSession) => ({
    childrenDisplayMode: host.sessionProjection.captureChildrenDisplay(row.key),
    snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
  });
  const sessions = snapshotSessions(rows, presentation);
  const sessionKeys = new Set(sessions.map((row) => row.key));
  return parseSidebarSnapshot({
    mode: host.sidebarAgentsMode,
    entries: zone.entries.map(serializeSidebarEntry).filter((value) => {
      const entry = parseSidebarEntry(value);
      return entry?.type !== "session" || sessionKeys.has(entry.key);
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
        ...user,
        identity: user.identity?.type === "profile" ? user.identity : undefined,
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
    footer: context.gateway.snapshot.selfUser
      ? {
          ...context.gateway.snapshot.selfUser,
          identity:
            context.gateway.snapshot.selfUser.identity?.type === "profile"
              ? context.gateway.snapshot.selfUser.identity
              : undefined,
        }
      : null,
    brand: readSidebarBrandPresentation(host),
  });
}
