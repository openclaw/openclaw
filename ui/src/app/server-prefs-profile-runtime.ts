import {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { isAppearancePref, type ServerUiPrefs } from "./server-prefs-state.ts";
import { invalidateUserPreferences, saveUserPreferences } from "./user-prefs-cache.ts";
import { loadUserPreferences } from "./user-prefs-request.ts";

export async function writeProfileAppearancePrefs(
  client: GatewayBrowserClient | null,
  batch: ServerUiPrefs,
  canDispatch: boolean,
): Promise<Awaited<ReturnType<RuntimeConfigCapability["runExternalMutation"]>>> {
  if (!client || !canDispatch) {
    return { ok: false, reason: "unavailable", error: "Profile preferences are unavailable." };
  }
  const writesTheme = batch.theme !== undefined || batch.themeMode !== undefined;
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
      return { ok: true, value, refresh: { ok: true } };
    }
    const entries = Object.fromEntries(
      Object.entries(batch).flatMap(([key, value]) =>
        isAppearancePref(key) ? [[UI_APPEARANCE_PREFERENCE_KEYS[key], value]] : [],
      ),
    );
    const result = await saveUserPreferences(client, { entries });
    return result.status === "ok"
      ? { ok: true, value: result, refresh: { ok: true } }
      : { ok: false, reason: "rejected", error: "Profile preferences are unavailable." };
  } catch (error) {
    const rejected =
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN");
    return {
      ok: false,
      reason: rejected ? "rejected" : "error",
      error: error instanceof Error ? error.message : String(error),
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
