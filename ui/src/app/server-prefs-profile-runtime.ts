import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import {
  normalizeTabIconPreference,
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ApplicationContext } from "./context.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import { isAppearancePref, SYNCED_PREFS, type ServerUiPrefs } from "./server-prefs-state.ts";
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
  canDispatch: boolean,
  expectedBackground?: BackgroundPreference | null,
): Promise<
  Awaited<ReturnType<RuntimeConfigCapability["runExternalMutation"]>> & { batch: ServerUiPrefs }
> {
  let batch = preferences;
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
  if (!client || !canDispatch) {
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
  const result = await loadUserPreferences(client, profileId, {
    keys: Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
  });
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
  return prefs;
}
