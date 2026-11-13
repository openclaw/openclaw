import type { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "./context.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import { readConfirmedPrefs } from "./server-prefs-confirmation.ts";
import type {
  ProfilePreferencesReadOptions,
  ProfilePreferencesState,
} from "./server-prefs-profile.ts";
import { loadLocalNavigationPreferences } from "./server-prefs-reconcile.ts";
import {
  SYNCED_PREFS,
  prefValuesEqual,
  extractProfileUiPrefs,
  PROFILE_UI_PREFERENCE_KEYS,
  type ServerUiPrefs,
} from "./server-prefs-state.ts";
import type { ServerUiPrefsWriter } from "./server-prefs-sync-contract.ts";
import { pushServerUiPrefs, serverUiPrefsOutbox as sync } from "./server-prefs.ts";
import { loadUserPreferences } from "./user-prefs-request.ts";

/** Presentation uses the same profile-only descriptors as the write owner. */

export function canSyncAppearancePreference(
  context: Pick<ApplicationContext, "gateway" | "runtimeConfig">,
  key?: keyof typeof UI_APPEARANCE_PREFERENCE_KEYS,
): boolean | null {
  const { runtimeConfig } = context;
  if (!runtimeConfig.state.connected) {
    return null;
  }
  const gateway = context.gateway.snapshot;
  if (key && SYNCED_PREFS[key].configSync === false && !gateway.selfUser) {
    return false;
  }
  return key && gateway.selfUser
    ? hasOperatorWriteAccess(gateway.hello?.auth ?? null)
    : runtimeConfig.canPatch !== false;
}

export async function readProfileAppearancePrefs(
  client: GatewayBrowserClient,
  profileId: string,
): Promise<ServerUiPrefs | null> {
  const params = {
    keys: PROFILE_UI_PREFERENCE_KEYS,
  };
  const result = await loadUserPreferences(client, profileId, params);
  if (result.status !== "ok") {
    return null;
  }
  return extractProfileUiPrefs(result.entries);
}

/** Called only after the existing async reader boundary, with the profile owner held by reference. */
export async function loadProfileAppearancePrefs(
  client: GatewayBrowserClient,
  profileId: string,
  scope: string,
  options: ProfilePreferencesReadOptions | undefined,
  state: Pick<ProfilePreferencesState, "appearance" | "requestId">,
  requestId: number,
): Promise<boolean> {
  if (requestId !== state.requestId) {
    return false;
  }
  const isCurrent = () => requestId === state.requestId && (options?.isCurrent() ?? true);
  const prefs = await readProfileAppearancePrefs(client, profileId);
  if (!isCurrent() || !prefs) {
    return false;
  }
  state.appearance = { profileId, scope, prefs };
  return true;
}

/** Adopt only this profile's authored browser layout before a remote snapshot can replace it. */
export function adoptLocalPersonalSessionGroups(
  writer: ServerUiPrefsWriter,
  hooks: Parameters<typeof pushServerUiPrefs>[2],
): void {
  if (
    sync.pushWriter !== writer ||
    !sync.canWriteProfilePref("personalSessionGroups") ||
    sync.pendingPrefs?.personalSessionGroups
  ) {
    return;
  }
  const scope = writer.state.client?.gatewayUrl ?? "";
  const local = loadLocalNavigationPreferences(scope, sync.pushProfileId)?.personalSessionGroups;
  const previous = readConfirmedPrefs(sync, sync.pushScope)?.personalSessionGroups ?? null;
  if (!local || prefValuesEqual(local, previous ?? [])) {
    return;
  }
  pushServerUiPrefs(
    writer,
    { personalSessionGroups: local, personalSessionGroupsBase: previous },
    hooks,
  );
}
