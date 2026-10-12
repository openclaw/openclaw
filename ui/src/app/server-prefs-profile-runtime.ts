import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import {
  normalizeTabIconPreference,
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ApplicationContext } from "./context.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import type {
  ProfilePreferencesReadOptions,
  ProfilePreferencesState,
} from "./server-prefs-profile.ts";
import {
  isAppearancePref,
  prefValuesEqual,
  isNavigationPref,
  SYNCED_PREFS,
  UI_NAVIGATION_PREFERENCE_KEYS,
  type ServerUiPrefs,
} from "./server-prefs-state.ts";
import { rebaseSidebarEntries } from "./server-prefs-write-batch.ts";
import { invalidateUserPreferences, saveUserPreferences } from "./user-prefs-cache.ts";
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

export async function writeProfileAppearancePrefs(
  client: GatewayBrowserClient | null,
  preferences: ServerUiPrefs,
  canDispatch: boolean | (() => boolean),
  profileId?: string | null,
  expectedBackground?: BackgroundPreference | null,
): Promise<
  Awaited<ReturnType<RuntimeConfigCapability["runExternalMutation"]>> & {
    batch: ServerUiPrefs;
    committedBatch?: ServerUiPrefs;
  }
> {
  let batch = preferences;
  const current = () => (typeof canDispatch === "function" ? canDispatch() : canDispatch);
  const writesNavigation = Object.keys(batch).some(isNavigationPref);
  if (writesNavigation) {
    batch = Object.fromEntries(Object.entries(batch).filter(([key]) => isNavigationPref(key)));
  }
  const writesTheme = batch.theme !== undefined || batch.themeMode !== undefined;
  if (writesTheme) {
    // themes.set owns the atomic theme/accent/font mutation, not other profile
    // values. Leave those pending for a separately authorized users.prefs.set.
    batch = Object.fromEntries(
      Object.entries(batch).filter(([key]) =>
        ["theme", "themeMode", "accent", "fontUi", "fontChat"].includes(key),
      ),
    );
  }
  if (!client || !current()) {
    return {
      ok: false,
      reason: "unavailable",
      error: "Profile preferences are unavailable.",
      batch,
    };
  }
  if (batch.background !== undefined && expectedBackground === undefined) {
    return {
      ok: false,
      reason: "unavailable",
      error: "Background preferences have not loaded.",
      batch,
    };
  }
  if (writesTheme) {
    invalidateUserPreferences(client);
  }
  try {
    if (writesNavigation) {
      if (!profileId) {
        return {
          ok: false,
          reason: "unavailable",
          error: "Navigation profile is unavailable.",
          batch,
        };
      }
      const base = preferences.sidebarEntriesBase;
      const keys = Object.keys(batch).filter(isNavigationPref);
      const snapshot = await loadUserPreferences(client, profileId, {
        keys: keys.map((key) => UI_NAVIGATION_PREFERENCE_KEYS[key]),
      });
      // A read without complete coverage is never absence and must not seed a write.
      if (!current() || snapshot.status !== "ok") {
        return {
          ok: false,
          reason: "unavailable",
          error: "Navigation preferences are unavailable.",
          batch,
        };
      }
      const committedBatch = { ...batch };
      if (Array.isArray(batch.sidebarEntries)) {
        const observed = SYNCED_PREFS.sidebarEntries.extract(base);
        const remote = SYNCED_PREFS.sidebarEntries.extract(
          snapshot.entries[UI_NAVIGATION_PREFERENCE_KEYS.sidebarEntries] ?? DEFAULT_SIDEBAR_ENTRIES,
        );
        if (!observed || !prefValuesEqual(observed, base)) {
          return {
            ok: false,
            reason: "rejected",
            error:
              "Shortcuts are saved only on this device because their previous sync state is missing. Edit a shortcut to sync again.",
            batch: { sidebarEntries: batch.sidebarEntries },
          };
        }
        if (!remote) {
          return {
            ok: false,
            reason: "unavailable",
            error: "Navigation preferences are unavailable.",
            batch,
          };
        }
        committedBatch.sidebarEntries = rebaseSidebarEntries(
          observed,
          batch.sidebarEntries,
          remote,
          preferences.sidebarEntriesOrder,
        );
      }
      const entries = Object.fromEntries(
        keys.map((key) => [UI_NAVIGATION_PREFERENCE_KEYS[key], committedBatch[key]]),
      );
      const expectedEntries = Object.fromEntries(
        keys.map((key) => {
          const prefKey = UI_NAVIGATION_PREFERENCE_KEYS[key];
          return [prefKey, snapshot.entries[prefKey] ?? null];
        }),
      );
      const result = await saveUserPreferences(client, { entries, expectedEntries });
      return result.status === "ok"
        ? { ok: true, value: result, refresh: { ok: true }, batch, committedBatch }
        : {
            ok: false,
            reason: result.status === "conflict" ? "conflict" : "unavailable",
            error: "Navigation preferences changed or are unavailable.",
            batch,
          };
    }
    if (writesTheme) {
      const appearance = {
        ...(batch.accent !== undefined ? { accent: batch.accent } : {}),
        ...(batch.fontUi !== undefined ? { fontUi: batch.fontUi } : {}),
        ...(batch.fontChat !== undefined ? { fontChat: batch.fontChat } : {}),
      };
      const value = await client.request("themes.set", {
        ...(batch.theme !== undefined ? { id: batch.theme } : {}),
        ...(batch.themeMode !== undefined ? { mode: batch.themeMode } : {}),
        ...(Object.keys(appearance).length ? { appearance } : {}),
      });
      return { ok: true, value, refresh: { ok: true }, batch };
    }
    if (batch.tabIcon != null && !normalizeTabIconPreference(batch.tabIcon)) {
      return { ok: false, reason: "rejected", error: "Invalid tab icon preference.", batch };
    }
    const entries = Object.fromEntries(
      Object.entries(batch).flatMap(([key, value]) =>
        isAppearancePref(key) ? [[UI_APPEARANCE_PREFERENCE_KEYS[key], value]] : [],
      ),
    );
    const result = await saveUserPreferences(client, {
      entries,
      ...(batch.background !== undefined
        ? { expectedEntries: { [UI_APPEARANCE_PREFERENCE_KEYS.background]: expectedBackground } }
        : {}),
    });
    return result.status === "ok"
      ? { ok: true, value: result, refresh: { ok: true }, batch }
      : {
          ok: false,
          reason: result.status === "conflict" ? "conflict" : "rejected",
          error: "Profile preferences are unavailable.",
          batch,
        };
  } catch (error) {
    const rejected =
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN");
    return {
      ok: false,
      reason: rejected ? "rejected" : "error",
      error: error instanceof Error ? error.message : String(error),
      batch,
    };
  } finally {
    if (writesTheme) {
      invalidateUserPreferences(client);
    }
  }
}

export async function readProfileAppearancePrefs(
  client: GatewayBrowserClient,
  profileId: string,
): Promise<ServerUiPrefs | null> {
  const params = {
    keys: [
      ...Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
      ...Object.values(UI_NAVIGATION_PREFERENCE_KEYS),
    ],
  };
  const result = await loadUserPreferences(client, profileId, params);
  if (result.status !== "ok") {
    return null;
  }
  const prefs: ServerUiPrefs = {};
  for (const [key, preferenceKey] of Object.entries(UI_APPEARANCE_PREFERENCE_KEYS)) {
    if (!isAppearancePref(key)) {
      continue;
    }
    const value = normalizeUiAppearancePreference(preferenceKey, result.entries[preferenceKey]);
    if (value !== undefined) {
      Object.assign(prefs, { [key]: value });
    }
  }
  for (const key of Object.keys(UI_NAVIGATION_PREFERENCE_KEYS).filter(isNavigationPref)) {
    const preferenceKey = UI_NAVIGATION_PREFERENCE_KEYS[key];
    const value = SYNCED_PREFS[key].extract(result.entries[preferenceKey]);
    if (value !== undefined) {
      Object.assign(prefs, { [key]: value });
    }
  }
  return prefs;
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
