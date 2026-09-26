import type {
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationTheme,
} from "./context.ts";
import { patchSettings, type UiSettings } from "./settings.ts";

export function createApplicationNavigationPreferences(
  preferences: Pick<ApplicationTheme, "settings" | "subscribe">,
): ApplicationNavigationPreferences {
  let navCollapsed = false;
  const snapshot = (): ApplicationNavigationPreferencesSnapshot => ({
    navCollapsed,
    navWidth: preferences.settings.navWidth,
    sidebarEntries: preferences.settings.sidebarEntries,
    pinnedAgentIds: preferences.settings.pinnedAgentIds ?? [],
  });
  const listeners = new Set<(next: ApplicationNavigationPreferencesSnapshot) => void>();

  return {
    get snapshot() {
      return snapshot();
    },
    update(patch) {
      const visibilityChanged =
        patch.navCollapsed !== undefined && patch.navCollapsed !== navCollapsed;
      if (patch.navCollapsed !== undefined) {
        navCollapsed = patch.navCollapsed;
      }
      // Persist only this action's fields; a sibling tab may have saved other
      // preferences before its storage event reaches this document.
      const persisted: Partial<UiSettings> = {};
      if (patch.navWidth !== undefined) {
        persisted.navWidth = patch.navWidth;
      }
      if (patch.sidebarEntries !== undefined) {
        persisted.sidebarEntries = [...patch.sidebarEntries];
      }
      if (patch.pinnedAgentIds !== undefined) {
        persisted.pinnedAgentIds = [...patch.pinnedAgentIds];
      }
      if (Object.keys(persisted).length > 0) {
        patchSettings(persisted);
      }
      if (visibilityChanged) {
        for (const listener of listeners) {
          listener(snapshot());
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      const stopPreferences = preferences.subscribe(() => listener(snapshot()));
      return () => {
        listeners.delete(listener);
        stopPreferences();
      };
    },
  };
}
