// Confirmed snapshot operations run only in the existing async read/write reconciliation boundary.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { generateUUID } from "../lib/uuid.ts";
import type { ServerUiPrefs, SyncedPrefKey } from "./server-prefs-state.ts";
import {
  LAST_SEEN_KEY,
  parseStoredPrefs,
  readStorageState,
  writeStorage,
} from "./server-prefs-storage.ts";
import type { ConfirmedPrefsFallback } from "./server-prefs-sync-contract.ts";

type ConfirmationOwner = { confirmedPrefsFallback: ConfirmedPrefsFallback | null };

/** LAST_SEEN's snapshot and per-key publication identities share one atomic browser record. */
export function readConfirmedPrefs(owner: ConfirmationOwner, scope: string): ServerUiPrefs | null {
  const stored = readStorageState(LAST_SEEN_KEY, scope);
  const fallback = owner.confirmedPrefsFallback;
  if (
    fallback?.scope === scope &&
    (!stored.available || (fallback.dirty && stored.value === fallback.raw))
  ) {
    return fallback.prefs;
  }
  const prefs = parseStoredPrefs(stored.value);
  if (prefs?.navigationConfirmation) {
    const receipt = asRecord(prefs.navigationConfirmation)?.sidebarEntries;
    prefs.navigationConfirmation =
      typeof receipt === "string" && receipt.length <= 64 ? { sidebarEntries: receipt } : {};
  }
  owner.confirmedPrefsFallback = { scope, raw: stored.value, prefs, dirty: false };
  return prefs;
}

export function publishConfirmedPrefs(
  owner: ConfirmationOwner,
  scope: string,
  prefs: ServerUiPrefs,
  confirmedKeys: readonly SyncedPrefKey[] = [],
): void {
  const previous = readConfirmedPrefs(owner, scope);
  const navigationConfirmation = { ...previous?.navigationConfirmation };
  if (!Object.hasOwn(prefs, "sidebarEntries")) {
    delete navigationConfirmation.sidebarEntries;
  } else if (confirmedKeys.includes("sidebarEntries")) {
    navigationConfirmation.sidebarEntries = generateUUID();
  }
  const next: ServerUiPrefs = { ...prefs, navigationConfirmation };
  if (!Object.keys(navigationConfirmation).length) {
    delete next.navigationConfirmation;
  }
  const raw = JSON.stringify(next);
  const persisted = writeStorage(LAST_SEEN_KEY, scope, raw);
  owner.confirmedPrefsFallback = {
    scope,
    raw: persisted ? raw : (owner.confirmedPrefsFallback?.raw ?? null),
    prefs: next,
    dirty: !persisted,
  };
}
