import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ServerUiPrefs } from "./server-prefs-state.ts";

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

export function rememberProfileAppearanceIdentity(scope: string, profileId: string): void {
  profileAppearanceIdentity = { scope, profileId };
}

export function resetProfileAppearancePrefs(): void {
  profileAppearancePrefs = null;
  profileAppearanceIdentity = null;
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
