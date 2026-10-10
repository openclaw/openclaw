import type { SidebarSnapshotModel } from "../components/sidebar-snapshot-model.ts";
import type { BootRoster } from "../lib/sessions/session-boot-roster.ts";

export function sidebarBootSnapshot(roster: BootRoster | null): SidebarSnapshotModel {
  return {
    routingDefaults: { mainKey: "main", scope: "per-sender" },
    roster: roster
      ? {
          ...roster,
          groups: [...roster.groups],
          groupSettings: [...roster.groupSettings],
          sectionOrder: [...roster.sectionOrder],
        }
      : null,
    mode: "roster",
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
