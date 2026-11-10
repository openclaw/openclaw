import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
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
// Profile appearance retains these markers through startup restoration. Legacy true markers
// await their first baseline; confirmed markers yield only to a later server delta or reset/retry.
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

export type RetainedLocalPref = {
  state: "pending" | "confirmed";
  // Absent only on legacy key-only markers. Null retains a local reset.
  value?: unknown;
};

export function readRetainedLocalPrefs(scope: string): Map<SyncedPrefKey, RetainedLocalPref> {
  const stored = parseStoredPrefs(readStorage(RETAINED_LOCAL_KEY, scope));
  if (!stored) {
    return new Map();
  }
  const keys = Object.keys(stored).filter((key) => Object.hasOwn(SYNCED_PREFS, key));
  // SAFETY: filtered against SYNCED_PREFS, so every key is a SyncedPrefKey.
  return new Map(
    (keys as SyncedPrefKey[]).map((key) => {
      const entry = asRecord(stored[key]);
      const value = entry?.value === null ? null : SYNCED_PREFS[key].extract(entry?.value);
      return [
        key,
        {
          state: entry?.state === "confirmed" ? "confirmed" : "pending",
          ...(value !== undefined ? { value } : {}),
        },
      ];
    }),
  );
}

export function writeRetainedLocalPrefs(
  scope: string,
  prefs: ReadonlyMap<SyncedPrefKey, RetainedLocalPref>,
): void {
  writeStorage(
    RETAINED_LOCAL_KEY,
    scope,
    prefs.size ? serializeStoredPrefs(Object.fromEntries(prefs)) : null,
  );
}
