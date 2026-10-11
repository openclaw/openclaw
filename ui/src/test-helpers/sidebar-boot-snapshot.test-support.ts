import type { SidebarSnapshotModel } from "../components/sidebar-snapshot-model.ts";
import { bootRosterSchema, type BootRoster } from "../lib/sessions/session-boot-roster.ts";

export function sidebarBootSnapshot(roster: BootRoster | null): SidebarSnapshotModel {
  return {
    routingDefaults: { mainKey: "main", scope: "per-sender" },
    roster: roster ? bootRosterSchema.parse(roster) : null,
    mode: "roster",
    navigationView: "sessions",
    navigationScope: "all",
    scopesEquivalent: false,
    pages: [],
    pageScopeId: null,
    pinnedSessions: [],
    entries: ["sessions"],
    sessions: [],
    sections: [],
    cards: [],
    collapsedAgentIds: [],
    collapsedSections: [],
    plugins: [],
    onlineUsers: [],
    onlineCounts: [],
    peopleSortMode: "presence",
    peopleStatusFilter: "all",
    onlineExpanded: false,
    ownerId: null,
    involvingMe: false,
    footer: null,
    brand: { name: "Synthetic workspace", avatar: null, icon: "mark", environment: null },
  };
}
