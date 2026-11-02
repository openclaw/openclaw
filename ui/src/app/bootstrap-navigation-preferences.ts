import { serializeSidebarEntry } from "../app-navigation.ts";
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
    sidebarAgentOrder: preferences.settings.sidebarAgentOrder ?? [],
    personalSessionGroups: preferences.settings.personalSessionGroups ?? [],
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
      for (const key of [
        "navWidth",
        "sidebarEntries",
        "sidebarAgentOrder",
        "personalSessionGroups",
        "pinnedAgentIds",
      ] as const) {
        const value = patch[key];
        if (value !== undefined) {
          Object.assign(persisted, { [key]: Array.isArray(value) ? [...value] : value });
        }
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
      // Forward persisted preferences through the synchronous navigation owner.
      const stopPreferences = preferences.subscribe(() => listener(snapshot()));
      return () => {
        listeners.delete(listener);
        stopPreferences();
      };
    },
  };
}

/** Both agent settings and the switcher use the same browser-profile pin preference. */
export function togglePinnedAgent(navigation: ApplicationNavigationPreferences, agentId: string) {
  const pinned = navigation.snapshot.pinnedAgentIds;
  const next = pinned.includes(agentId)
    ? pinned.filter((id) => id !== agentId)
    : [...pinned, agentId];
  navigation.update({ pinnedAgentIds: next });
}

/** Menu surfaces share the personal reference owner instead of patching session metadata. */
export function togglePinnedSession(
  navigation: ApplicationNavigationPreferences,
  sessionKey: string,
) {
  const entry = serializeSidebarEntry({ type: "session", key: sessionKey });
  const entries = navigation.snapshot.sidebarEntries;
  navigation.update({
    sidebarEntries: entries.includes(entry)
      ? entries.filter((candidate) => candidate !== entry)
      : [...entries, entry],
  });
}
