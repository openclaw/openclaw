import { SYNCED_PREF_KEYS, type ServerUiPrefs } from "./server-prefs-state.ts";
import {
  clearBackgroundPreferenceIdentity,
  setBackgroundPreferenceIdentity,
} from "./settings-background.ts";

export type ProfilePreferencesReadOptions = {
  isCurrent: () => boolean;
};

// The asynchronous reader borrows this same owner, never a copied publication state.
export type ProfilePreferencesState = {
  appearance: {
    profileId: string;
    scope: string;
    prefs: ServerUiPrefs;
  } | null;
  identity: { profileId: string; scope: string } | null;
  requestId: number;
  // Cached refreshes survive newer reads, but not write or identity invalidation.
  invalidationId: number;
};
export const profilePreferencesState: ProfilePreferencesState = {
  appearance: null,
  identity: null,
  requestId: 0,
  invalidationId: 0,
};

// Eager identity updates and the deferred reader share this owner and request generation.
const state = profilePreferencesState;

export function resolveProfilePreferenceScope(scope: string, profileId?: string | null): string {
  return profileId ? `${scope}:profile:${profileId}` : scope;
}

export function resolveProfileAppearanceProfileId(scope: string): string | null {
  return state.identity?.scope === scope ? state.identity.profileId : null;
}

export function resolveProfileAppearancePrefs(
  scope: string,
  profileId?: string | null,
): ServerUiPrefs | null {
  return profileId && state.appearance?.profileId === profileId && state.appearance.scope === scope
    ? state.appearance.prefs
    : null;
}

export function rememberProfileAppearanceIdentity(
  scope: string,
  profileId: string | null,
): boolean {
  if (state.identity?.scope !== scope || state.identity.profileId !== profileId) {
    invalidateProfileAppearanceReads(true);
  }
  state.identity = profileId ? { scope, profileId } : null;
  return setBackgroundPreferenceIdentity(scope, profileId);
}

/** A commit retires older reads without discarding the current projection. */
export function invalidateProfileAppearanceReads(clearSnapshot = false): void {
  state.requestId += 1;
  state.invalidationId += 1;
  if (clearSnapshot) {
    state.appearance = null;
  }
}

export function recordProfileAppearanceCommit(
  scope: string,
  profileId: string,
  batch: ServerUiPrefs,
): void {
  const prefs = resolveProfileAppearancePrefs(scope, profileId);
  if (state.identity?.scope !== scope || state.identity.profileId !== profileId || !prefs) {
    return;
  }
  for (const key of SYNCED_PREF_KEYS) {
    if (!Object.hasOwn(batch, key)) {
      continue;
    }
    if (batch[key] === null) {
      delete prefs[key];
    } else {
      Object.assign(prefs, { [key]: batch[key] });
    }
  }
}

export function resetProfileAppearancePrefs(): void {
  invalidateProfileAppearanceReads(true);
  state.identity = null;
  clearBackgroundPreferenceIdentity();
}

export function seedProfileAppearancePrefs(
  scope: string,
  profileId: string,
  prefs: ServerUiPrefs,
): void {
  rememberProfileAppearanceIdentity(scope, profileId);
  state.appearance = { scope, profileId, prefs };
}
