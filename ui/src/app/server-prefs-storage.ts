import { safeParseJson } from "@openclaw/normalization-core";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SYNCED_PREFS,
  clearSidebarEntriesMetadata,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";

// localStorage persistence primitives for the synced-prefs engine. Stateless:
// every helper is (root, scope)-parameterized; scope adoption, pending shadows,
// and reconcile state stay in server-prefs.ts.

// Last server value this client reconciled against, persisted per gateway scope. Applying only on
// a server delta keeps an unpushable local edit (viewer scope) from being reverted by every later
// snapshot, including the first snapshot after reload or reconnect carrying the same old value.
export const LAST_SEEN_KEY = "openclaw.control.serverPrefs.v1";
// Pending keys are local edits not yet acknowledged by the gateway. They shadow reconciliation so
// snapshots cannot revert unacked edits, and persist so offline edits replay after reload/reconnect.
export const PENDING_KEY = "openclaw.control.serverPrefs.pending.v1";
// Connected read-only edits never enter the replay outbox. Retain only their keys until the next
// snapshot establishes a LAST_SEEN baseline, then normal server-delta reconciliation resumes.
const RETAINED_LOCAL_KEY = "openclaw.control.serverPrefs.retained-local.v1";

// The sync engine keeps its in-memory vocabulary; persisted rail intent has a fresh identity.
const navigationStorageKeys = {
  sidebarEntries: "railShortcuts",
  sidebarEntriesBase: "railShortcutsBase",
  sidebarEntriesOrder: "railShortcutsOrder",
} as const;

export function serializeStoredPrefs(prefs: ServerUiPrefs): string {
  const stored: Record<string, unknown> = { ...prefs };
  for (const [key, storageKey] of Object.entries(navigationStorageKeys)) {
    delete stored[key];
    if (Object.hasOwn(prefs, key)) {
      stored[storageKey] = prefs[key];
    }
  }
  if (prefs.navigationConfirmation) {
    stored.navigationConfirmation = { railShortcuts: prefs.navigationConfirmation.sidebarEntries };
  }
  return JSON.stringify(stored);
}

export function readStorageState(
  root: string,
  scope: string,
): { available: boolean; value: string | null } {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return { available: false, value: null };
    }
    return { available: true, value: storage.getItem(`${root}:${scope}`) };
  } catch {
    return { available: false, value: null };
  }
}

export function readStorage(root: string, scope: string): string | null {
  return readStorageState(root, scope).value;
}

export function writeStorage(root: string, scope: string, value: string | null): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return false;
    }
    const key = `${root}:${scope}`;
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
    return true;
  } catch {
    // Quota/security failures degrade to in-memory tracking for this session.
    return false;
  }
}

export function parseStoredPrefs(raw: string | null): ServerUiPrefs | null {
  const prefs = asRecord(safeParseJson(raw ?? "null"));
  if (prefs) {
    for (const [key, storageKey] of Object.entries(navigationStorageKeys)) {
      delete prefs[key];
      if (Object.hasOwn(prefs, storageKey)) {
        prefs[key] = prefs[storageKey];
        delete prefs[storageKey];
      }
    }
    const confirmation = asRecord(prefs.navigationConfirmation);
    if (confirmation) {
      if (Object.hasOwn(confirmation, "railShortcuts")) {
        prefs.navigationConfirmation = { sidebarEntries: confirmation.railShortcuts };
      } else {
        delete prefs.navigationConfirmation;
      }
    }
  }
  if (prefs && !Array.isArray(prefs.sidebarEntries)) {
    clearSidebarEntriesMetadata(prefs);
  }
  if (prefs && prefs.sidebarEntriesOrder !== true) {
    delete prefs.sidebarEntriesOrder;
  }
  // SAFETY: consumers re-validate per key against SYNCED_PREFS extractors.
  return prefs && Object.keys(prefs).length ? (prefs as ServerUiPrefs) : null;
}

export function readStoredPrefs(
  root: string,
  scope: string,
): { available: boolean; prefs: ServerUiPrefs | null } {
  const stored = readStorageState(root, scope);
  return {
    available: stored.available,
    prefs: parseStoredPrefs(stored.value),
  };
}

export function readRetainedLocalKeys(scope: string): Set<SyncedPrefKey> {
  const stored = parseStoredPrefs(readStorage(RETAINED_LOCAL_KEY, scope));
  if (!stored) {
    return new Set();
  }
  const keys = Object.keys(stored).filter((key) => Object.hasOwn(SYNCED_PREFS, key));
  // SAFETY: filtered against SYNCED_PREFS, so every key is a SyncedPrefKey.
  return new Set(keys as SyncedPrefKey[]);
}

export function writeRetainedLocalKeys(scope: string, keys: ReadonlySet<SyncedPrefKey>): void {
  writeStorage(
    RETAINED_LOCAL_KEY,
    scope,
    keys.size
      ? serializeStoredPrefs(Object.fromEntries([...keys].map((key) => [key, true])))
      : null,
  );
}
