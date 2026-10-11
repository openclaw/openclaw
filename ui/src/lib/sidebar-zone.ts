import {
  parseSidebarEntry,
  serializeSidebarEntry,
  type SidebarNavRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";

/** Personal references are the only pin authority. Catalogs resolve display, never membership. */
export function reconcileSidebarZone(
  sidebarEntries: readonly string[],
  availableSessions: readonly { key: string }[],
  validRoutes: readonly SidebarNavRoute[],
  pluginNavigationKeys: ReadonlySet<string> = new Set(),
): { entries: SidebarZoneEntry[]; sidebarEntries: string[] } {
  const sessionKeys = new Set(availableSessions.map(({ key }) => key));
  const routes = new Set(validRoutes);
  const canonical = new Set<string>();
  const entries: SidebarZoneEntry[] = [];
  for (const serialized of sidebarEntries) {
    const entry = parseSidebarEntry(serialized);
    if (!entry) {
      continue;
    }
    const key = serializeSidebarEntry(entry);
    if (canonical.has(key)) {
      continue;
    }
    canonical.add(key);
    // Preserve unresolved references without persisting private labels or treating
    // a missing paginated row, offline person, or unloaded plugin as an unpin.
    if (
      entry.type === "person" ||
      (entry.type === "route" && routes.has(entry.route)) ||
      (entry.type === "session" && sessionKeys.has(entry.key)) ||
      (entry.type === "plugin" && pluginNavigationKeys.has(entry.key))
    ) {
      entries.push(entry);
    }
  }
  return { entries, sidebarEntries: [...canonical] };
}
