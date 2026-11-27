// Confirmed snapshot operations run only in the existing async read/write reconciliation boundary.
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
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
  // On rollback, older clients compare this baseline with the server before restoring
  // browser-only sections. A missing baseline looks like a change and clears their layout.
  const previous = owner.confirmedPrefsFallback;
  const retiredSections =
    previous?.scope === scope && previous.raw
      ? asNullableRecord(safeParseJson(previous.raw))?.personalSessionGroups
      : undefined;
  const raw = serializeStoredPrefs(
    retiredSections === undefined ? prefs : { ...prefs, personalSessionGroups: retiredSections },
  );
  const persisted = writeStorage(LAST_SEEN_KEY, scope, raw);
  owner.confirmedPrefsFallback = {
    scope,
    raw: persisted ? raw : (owner.confirmedPrefsFallback?.raw ?? null),
    prefs,
    dirty: !persisted,
  };
}
