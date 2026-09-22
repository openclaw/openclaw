import type {
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
} from "./context.ts";
import { patchSettings, type UiSettings } from "./settings.ts";

export function createApplicationNavigationPreferences(
  initialSettings: UiSettings,
  navCollapsed: boolean,
): ApplicationNavigationPreferences {
  let snapshot: ApplicationNavigationPreferencesSnapshot = {
    navCollapsed,
    navWidth: initialSettings.navWidth,
    sidebarEntries: initialSettings.sidebarEntries,
    pinnedAgentIds: initialSettings.pinnedAgentIds ?? [],
  };
  const listeners = new Set<(next: ApplicationNavigationPreferencesSnapshot) => void>();

  return {
    get snapshot() {
      return snapshot;
    },
    update(patch) {
      const nextSnapshot = { ...snapshot, ...patch };
      const persistedChanged =
        nextSnapshot.navWidth !== snapshot.navWidth ||
        nextSnapshot.sidebarEntries !== snapshot.sidebarEntries ||
        nextSnapshot.pinnedAgentIds !== snapshot.pinnedAgentIds;
      if (!persistedChanged && nextSnapshot.navCollapsed === snapshot.navCollapsed) {
        return;
      }
      if (persistedChanged) {
        patchSettings({
          navWidth: nextSnapshot.navWidth,
          sidebarEntries: [...nextSnapshot.sidebarEntries],
          pinnedAgentIds: [...nextSnapshot.pinnedAgentIds],
        });
      }
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
