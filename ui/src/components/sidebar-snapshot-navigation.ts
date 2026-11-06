import { parseSidebarEntry } from "../app-navigation.ts";
import { restoreSnapshotSession, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

export function restoreSnapshotNavigation(model: SidebarSnapshotModel, selectedKey: string) {
  const sections = model.sections.map((section) => ({
    ...section,
    rows: section.rows.map((row) => restoreSnapshotSession(row, selectedKey)),
  }));
  const visibleRows = sections.flatMap((section) => section.rows);
  const pins = model.pinnedSessions.map((row) => restoreSnapshotSession(row, selectedKey));
  return {
    sections,
    visibleRows,
    presence: {
      presence: model.onlineUsers.map((user) => ({
        ts: 0,
        user,
        watchedSessions: user.watchedSessions,
      })),
    },
    zone: {
      entries: model.entries.flatMap((entry) => {
        const parsed = parseSidebarEntry(entry);
        return parsed ? [parsed] : [];
      }),
      sidebarEntries: model.entries,
      sessionRows: new Map([...visibleRows, ...pins].map((row) => [row.key, row])),
      pluginTabs: new Map(model.plugins.map(({ key, ...tab }) => [key, tab])),
    },
  };
}
