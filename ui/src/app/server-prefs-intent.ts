import {
  prefValuesEqual,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import type { UiSettings } from "./settings.ts";

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

export function requestServerUiPrefWrite(key: SyncedPrefKey): void {
  requestedUiPrefWrites.add(key);
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
      if (specification.write) {
        prefs[key] = null;
      }
      continue;
    }
    // SAFETY: SYNCED_PREFS[key].local returns the value type owned by this exact key.
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
