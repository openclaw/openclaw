import {
  prefValuesEqual,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import { loadSettings, patchSettings, type UiSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";

const requestedServerUiPrefResets = new Set<SyncedPrefKey>();
const requestedDeviceLocalPrefResets = new Set<SyncedPrefKey>();
const requestedUiPrefWrites = new Set<SyncedPrefKey>();

export function requestServerUiPrefReset(
  key: SyncedPrefKey,
  scope: "server" | "device-local",
): void {
  (scope === "device-local" ? requestedDeviceLocalPrefResets : requestedServerUiPrefResets).add(
    key,
  );
}

export function resetServerUiPrefIntent(): void {
  requestedServerUiPrefResets.clear();
  requestedDeviceLocalPrefResets.clear();
  requestedUiPrefWrites.clear();
}

/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    const explicitWrite = requestedUiPrefWrites.delete(key);
    const serverReset = requestedServerUiPrefResets.delete(key);
    if (requestedDeviceLocalPrefResets.delete(key)) {
      continue;
    }
    if (serverReset) {
      prefs[key] = null;
      continue;
    }
    const specification = SYNCED_PREFS[key];
    const previousValue = specification.local(previous);
    const nextValue = specification.local(next);
    if (!explicitWrite && prefValuesEqual(previousValue, nextValue)) {
      continue;
    }
    if (nextValue === undefined) {
      // JSON merge patch removes keys via explicit null.
      if (specification.clearable) {
        prefs[key] = null;
      }
      continue;
    }
    // SAFETY: SYNCED_PREFS[key].local returns the value type owned by this exact key.
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
/** Explicit user selection only; incoming snapshots and mode changes never reset design choices. */
export function selectThemeSettings(
  theme: ThemeName,
  patch: Pick<Partial<UiSettings>, "customTheme"> = {},
): UiSettings {
  if (theme === loadSettings().theme) {
    return patchSettings({ ...patch, theme });
  }
  // Clear even unresolved profile values: a missing boot mirror is not evidence
  // that the server has no font override. Send these with the theme in one batch.
  // Carry the whole selection intent even if another tab already mirrors this
  // marker, so a read-only selection can cancel every older queued design edit.
  requestedUiPrefWrites.add("accent");
  requestedServerUiPrefResets.add("fontUi");
  requestedServerUiPrefResets.add("fontChat");
  return patchSettings({
    ...patch,
    theme,
    fontUi: undefined,
    fontChat: undefined,
    accent: "theme",
  });
}
