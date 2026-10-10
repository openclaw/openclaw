import type { GatewayBrowserClient } from "../api/gateway.ts";
import { SYNCED_PREF_KEYS, type ServerUiPrefs } from "./server-prefs-state.ts";
import {
  clearBackgroundPreferenceIdentity,
  setBackgroundPreferenceIdentity,
} from "./settings-background.ts";
import { refreshUiPreferences } from "./settings.ts";

type ProfileAppearancePrefs = { profileId: string; scope: string; prefs: ServerUiPrefs };

let profileAppearancePrefs: ProfileAppearancePrefs | null = null;
let profileAppearanceIdentity: { profileId: string; scope: string } | null = null;
let profilePreferencesRequestId = 0;

export function resolveProfilePreferenceScope(scope: string, profileId?: string | null): string {
  return profileId ? `${scope}:profile:${profileId}` : scope;
}

export function resolveProfileAppearancePrefs(
  scope: string,
  profileId?: string | null,
): ServerUiPrefs | null {
  return profileId &&
    profileAppearancePrefs?.profileId === profileId &&
    profileAppearancePrefs.scope === scope
    ? profileAppearancePrefs.prefs
    : null;
}

export function resolveProfileAppearanceProfileId(scope: string): string | null {
  return profileAppearanceIdentity?.scope === scope ? profileAppearanceIdentity.profileId : null;
}

export function rememberProfileAppearanceIdentity(
  scope: string,
  profileId: string | null,
): boolean {
  if (
    profileAppearanceIdentity?.scope !== scope ||
    profileAppearanceIdentity.profileId !== profileId
  ) {
    profilePreferencesRequestId += 1;
    profileAppearancePrefs = null;
  }
  profileAppearanceIdentity = profileId ? { scope, profileId } : null;
  const changed = setBackgroundPreferenceIdentity(scope, profileId);
  if (changed) {
    refreshUiPreferences();
  }
  return changed;
}

/** A write retires reads started before its commit without discarding the current projection. */
export function invalidateProfileAppearanceReads(clearSnapshot = false): void {
  profilePreferencesRequestId += 1;
  if (clearSnapshot) {
    profileAppearancePrefs = null;
  }
}

export function recordProfileAppearanceCommit(
  scope: string,
  profileId: string,
  batch: ServerUiPrefs,
): void {
  if (
    profileAppearanceIdentity?.scope !== scope ||
    profileAppearanceIdentity.profileId !== profileId
  ) {
    return;
  }
  if (!profileAppearancePrefs) {
    return;
  }
  for (const key of SYNCED_PREF_KEYS) {
    if (!Object.hasOwn(batch, key)) {
      continue;
    }
    if (batch[key] === null) {
      delete profileAppearancePrefs.prefs[key];
    } else {
      Object.assign(profileAppearancePrefs.prefs, { [key]: batch[key] });
    }
  }
}

export function resetProfileAppearancePrefs(): void {
  profileAppearancePrefs = null;
  profileAppearanceIdentity = null;
  clearBackgroundPreferenceIdentity();
  refreshUiPreferences();
  profilePreferencesRequestId += 1;
}

export async function loadProfileAppearancePrefs(
  client: GatewayBrowserClient,
  profileId: string,
  scope: string,
): Promise<boolean> {
  rememberProfileAppearanceIdentity(scope, profileId);
  const requestId = ++profilePreferencesRequestId;
  const { readProfileAppearancePrefs } = await import("./server-prefs-profile-runtime.ts");
  if (requestId !== profilePreferencesRequestId) {
    return false;
  }
  const prefs = await readProfileAppearancePrefs(client, profileId);
  if (requestId !== profilePreferencesRequestId || !prefs) {
    return false;
  }
  profileAppearancePrefs = { profileId, scope, prefs };
  return true;
}
