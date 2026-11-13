import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import {
  normalizeTabIconPreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import {
  normalizePersonalSessionGroups,
  type PersonalSessionGroup,
} from "../../../src/shared/personal-session-groups.js";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import type { RuntimeConfigExternalMutationResult } from "../lib/config/config-gateway-operations.ts";
import { formatUiError } from "../lib/format-error.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { prefIntentMatches, pendingUiPrefKeys } from "./server-prefs-intent.ts";
// Write-only algorithms load with the existing async preference drain, not the boot mirror.
import { extractServerUiPrefs } from "./server-prefs-reconcile.ts";
import {
  isProfilePref,
  isAppearancePref,
  isNavigationPref,
  SYNCED_PREFS,
  UI_NAVIGATION_PREFERENCE_KEYS,
  clearSidebarEntriesMetadata,
  prefValuesEqual,
  SYNCED_PREF_KEYS,
  type ServerUiPrefs,
} from "./server-prefs-state.ts";
import { invalidateUserPreferences, saveUserPreferences } from "./user-prefs-cache.ts";
import { loadUserPreferences } from "./user-prefs-request.ts";

/** Rebase only authored membership/order changes, preserving unseen remote pins and removals. */
export function rebaseSidebarEntries(
  base: readonly string[],
  desired: readonly string[],
  remote: readonly string[],
  reordered = false,
): string[] {
  const wanted = new Set(desired);
  const original = new Set(base);
  // Composed ordering also observes pins added by an earlier unacknowledged edit.
  // Their absence from the membership base must not freeze their old remote slots.
  const ordered = reordered ? wanted : original;
  const remoteSet = new Set(remote);
  const removed = new Set(base.filter((entry) => !wanted.has(entry)));
  let result = remote.filter((entry) => !removed.has(entry));
  const survivors = desired.filter((entry) => ordered.has(entry) && remoteSet.has(entry));
  const previousOrder = base.filter((entry) => wanted.has(entry) && remoteSet.has(entry));
  if (reordered || !prefValuesEqual(survivors, previousOrder)) {
    // Reorder only the entries this action actually observed. Remote-only slots stay put.
    let index = 0;
    result = result.map((entry) => (ordered.has(entry) ? (survivors[index++] ?? entry) : entry));
  }
  for (let index = 0; index < desired.length; index += 1) {
    const entry = desired[index]!;
    if (original.has(entry) || result.includes(entry)) {
      continue;
    }
    const predecessor = desired.slice(0, index).findLast((candidate) => result.includes(candidate));
    const successor = desired.slice(index + 1).find((candidate) => result.includes(candidate));
    const position =
      predecessor !== undefined
        ? result.indexOf(predecessor) + 1
        : successor !== undefined
          ? result.indexOf(successor)
          : result.length;
    result.splice(position, 0, entry);
  }
  return result;
}

/** Merge independent group edits; conflicting edits to the same group require review. */
export function rebasePersonalSessionGroups(
  base: readonly PersonalSessionGroup[],
  desired: readonly PersonalSessionGroup[],
  remote: readonly PersonalSessionGroup[],
): PersonalSessionGroup[] | undefined {
  const previous = new Map(base.map((group) => [group.id, group]));
  const wanted = new Map(desired.map((group) => [group.id, group]));
  const result = new Map(remote.map((group) => [group.id, group]));
  for (const id of new Set([...previous.keys(), ...wanted.keys()])) {
    const before = previous.get(id);
    const next = wanted.get(id);
    if (prefValuesEqual(before, next)) {
      continue;
    }
    if (!prefValuesEqual(result.get(id), before) && !prefValuesEqual(result.get(id), next)) {
      return undefined;
    }
    if (next) {
      result.set(id, next);
    } else {
      result.delete(id);
    }
  }
  const merged = rebaseSidebarEntries(
    base.map((group) => group.id),
    desired.map((group) => group.id),
    // Locally added IDs must be inserted at their authored position, including
    // when an earlier unacknowledged write already put them in the remote map.
    [...result.keys()].filter((id) => previous.has(id) || !wanted.has(id)),
  ).map((id) => result.get(id)!);
  return prefValuesEqual(normalizePersonalSessionGroups(merged), merged) ? merged : undefined;
}

export function selectProfileUiPrefs(
  pending: ServerUiPrefs,
  canWrite: (key: string) => boolean,
): ServerUiPrefs {
  const batch: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (isProfilePref(key) && canWrite(key) && Object.hasOwn(pending, key)) {
      Object.assign(batch, { [key]: pending[key] });
    }
  }
  if (batch.personalSessionGroups) {
    batch.personalSessionGroupsBase = pending.personalSessionGroupsBase;
  }
  if (batch.sidebarEntries && pending.sidebarEntriesBase) {
    batch.sidebarEntriesBase = pending.sidebarEntriesBase;
    batch.sidebarEntriesOrder = pending.sidebarEntriesOrder;
  }
  return batch;
}

export function removePendingUiPrefsBatch(
  pending: ServerUiPrefs | null,
  batch: ServerUiPrefs,
  persistedKeys: Set<string>,
): ServerUiPrefs | null {
  if (!pending) {
    return null;
  }
  for (const key of pendingUiPrefKeys(batch)) {
    if (Object.hasOwn(batch, key) && prefIntentMatches(pending, batch, key)) {
      delete pending[key];
      persistedKeys.delete(key);
    }
  }
  if (!pending.sidebarEntries) {
    clearSidebarEntriesMetadata(pending);
  }
  if (!pending.personalSessionGroups) {
    delete pending.personalSessionGroupsBase;
  }
  return Object.keys(pending).length ? pending : null;
}

export function serverUiPrefsCommittedSnapshot(
  lastSeen: ServerUiPrefs,
  committed: ServerUiPrefs,
  profilePrefs: ServerUiPrefs | null,
  configObject: unknown,
): ServerUiPrefs {
  const next = { ...lastSeen, ...committed };
  clearSidebarEntriesMetadata(next);
  if (!profilePrefs) {
    return next;
  }
  const configPrefs = extractServerUiPrefs(configObject);
  for (const key of SYNCED_PREF_KEYS) {
    if (!Object.hasOwn(committed, key)) {
      continue;
    }
    if (committed[key] === null) {
      if (configPrefs[key] === undefined) {
        delete next[key];
      } else {
        Object.assign(next, { [key]: configPrefs[key] });
      }
    }
  }
  return next;
}

export async function writeProfileAppearancePrefs(
  client: GatewayBrowserClient | null,
  preferences: ServerUiPrefs,
  canDispatch: () => boolean,
  profileId?: string | null,
  expectedBackground?: BackgroundPreference | null,
): Promise<
  RuntimeConfigExternalMutationResult<unknown> & {
    batch: ServerUiPrefs;
    committedBatch?: ServerUiPrefs;
  }
> {
  let batch = preferences;
  const failure = (
    error: string,
    reason: Extract<
      RuntimeConfigExternalMutationResult<unknown>,
      { ok: false }
    >["reason"] = "unavailable",
    failedBatch = batch,
  ) => ({ ok: false as const, reason, error, batch: failedBatch });
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
  if (!client || !canDispatch()) {
    return failure("Profile preferences are unavailable.");
  }
  if (batch.background !== undefined && expectedBackground === undefined) {
    return failure("Background preferences have not loaded.");
  }
  if (writesTheme) {
    invalidateUserPreferences(client);
  }
  try {
    if (writesNavigation) {
      if (!profileId) {
        return failure("Navigation profile is unavailable.");
      }
      const base = preferences.sidebarEntriesBase;
      const keys = Object.keys(batch).filter(isNavigationPref);
      const snapshot = await loadUserPreferences(client, profileId, {
        keys: keys.map((key) => UI_NAVIGATION_PREFERENCE_KEYS[key]),
      });
      // A read without complete coverage is never absence and must not seed a write.
      if (!canDispatch() || snapshot.status !== "ok") {
        return failure("Navigation preferences are unavailable.");
      }
      const committedBatch = { ...batch };
      if (batch.personalSessionGroups) {
        const observed = preferences.personalSessionGroupsBase;
        const remote = SYNCED_PREFS.personalSessionGroups.extract(
          snapshot.entries[UI_NAVIGATION_PREFERENCE_KEYS.personalSessionGroups] ?? [],
        );
        const merged =
          observed !== undefined && remote
            ? rebasePersonalSessionGroups(observed ?? [], batch.personalSessionGroups, remote)
            : undefined;
        if (!merged) {
          const { registerPreferencesEnglish } = await import("../i18n/locales/en-preferences.ts");
          registerEnglishCatalog(registerPreferencesEnglish);
          return failure(t("quickSettings.personal.groupsConflict"), "conflict");
        }
        committedBatch.personalSessionGroups = merged;
      }
      if (Array.isArray(batch.sidebarEntries)) {
        const observed = SYNCED_PREFS.sidebarEntries.extract(base);
        const remote = SYNCED_PREFS.sidebarEntries.extract(
          snapshot.entries[UI_NAVIGATION_PREFERENCE_KEYS.sidebarEntries] ?? DEFAULT_SIDEBAR_ENTRIES,
        );
        if (!observed || !prefValuesEqual(observed, base)) {
          const { registerPreferencesEnglish } = await import("../i18n/locales/en-preferences.ts");
          registerEnglishCatalog(registerPreferencesEnglish);
          return failure(t("quickSettings.personal.shortcutsLocalOnly"), "rejected", {
            sidebarEntries: batch.sidebarEntries,
          });
        }
        if (!remote) {
          return failure("Navigation preferences are unavailable.");
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
        : failure(
            "Navigation preferences changed or are unavailable.",
            result.status === "conflict" ? "conflict" : "unavailable",
          );
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
      return failure("Invalid tab icon preference.", "rejected");
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
      : failure(
          "Profile preferences are unavailable.",
          result.status === "conflict" ? "conflict" : "rejected",
        );
  } catch (error) {
    const rejected =
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN");
    return failure(formatUiError(error), rejected ? "rejected" : "error");
  } finally {
    if (writesTheme) {
      invalidateUserPreferences(client);
    }
  }
}
