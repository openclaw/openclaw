import {
  parseSidebarEntry,
  serializeSidebarEntry,
  type SidebarNavRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";

export type SidebarPinnedSession = { key: string };

export function reconcileSidebarZone(
  sidebarEntries: readonly string[],
  pinnedSessions: readonly SidebarPinnedSession[],
  validRoutes: readonly SidebarNavRoute[],
): { entries: SidebarZoneEntry[]; sidebarEntries: string[] } {
  const pinnedKeys = new Set(pinnedSessions.map((session) => session.key));
  const validRouteSet = new Set(validRoutes);
  const seen = new Set<string>();
  const entries: SidebarZoneEntry[] = [];

  for (const serialized of sidebarEntries) {
    const entry = parseSidebarEntry(serialized);
    if (
      !entry ||
      (entry.type === "route" && !validRouteSet.has(entry.route)) ||
      (entry.type === "session" && !pinnedKeys.has(entry.key))
    ) {
      continue;
    }
    const canonical = serializeSidebarEntry(entry);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      entries.push(entry);
    }
  }

  for (const session of pinnedSessions) {
    const entry = { type: "session", key: session.key } as const;
    const serialized = serializeSidebarEntry(entry);
    if (!seen.has(serialized)) {
      seen.add(serialized);
      entries.push(entry);
    }
  }

  return { entries, sidebarEntries: entries.map(serializeSidebarEntry) };
}
