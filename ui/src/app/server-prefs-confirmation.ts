// Confirmed snapshot operations run only in the existing async read/write reconciliation boundary.
import type { ServerUiPrefs } from "./server-prefs-state.ts";
import {
  LAST_SEEN_KEY,
  parseStoredPrefs,
  serializeStoredPrefs,
  readStorageState,
  writeStorage,
} from "./server-prefs-storage.ts";
import type { ConfirmedPrefsFallback } from "./server-prefs-sync-contract.ts";

type ConfirmationOwner = { confirmedPrefsFallback: ConfirmedPrefsFallback | null };

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
  owner.confirmedPrefsFallback = { scope, raw: stored.value, prefs, dirty: false };
  return prefs;
}

export function publishConfirmedPrefs(
  owner: ConfirmationOwner,
  scope: string,
  prefs: ServerUiPrefs,
): void {
  const raw = serializeStoredPrefs(prefs);
  const persisted = writeStorage(LAST_SEEN_KEY, scope, raw);
  owner.confirmedPrefsFallback = {
    scope,
    raw: persisted ? raw : (owner.confirmedPrefsFallback?.raw ?? null),
    prefs,
    dirty: !persisted,
  };
}
