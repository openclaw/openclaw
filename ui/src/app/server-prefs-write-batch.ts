import { prefIntentMatches, pendingUiPrefKeys } from "./server-prefs-intent.ts";
// Write-only algorithms load with the existing async preference drain, not the boot mirror.
import { extractServerUiPrefs } from "./server-prefs-reconcile.ts";
import {
  isProfilePref,
  clearSidebarEntriesMetadata,
  prefValuesEqual,
  SYNCED_PREF_KEYS,
  type ServerUiPrefs,
} from "./server-prefs-state.ts";

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

export function selectProfileUiPrefs(pending: ServerUiPrefs): ServerUiPrefs {
  const batch: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (isProfilePref(key) && Object.hasOwn(pending, key)) {
      Object.assign(batch, { [key]: pending[key] });
    }
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
