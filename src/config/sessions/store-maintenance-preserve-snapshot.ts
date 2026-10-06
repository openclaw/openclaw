import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export type SessionMaintenancePreservationSnapshot = {
  providerKeys: string[];
  workIdentities: string[];
  lifecycleIdentities: string[];
};

export function addSessionMaintenancePreserveKeys(
  keys: Set<string>,
  values: Iterable<string | undefined> | undefined,
): void {
  for (const value of values ?? []) {
    const normalized = normalizeStoreSessionKey(value ?? "");
    if (normalized) {
      keys.add(normalized);
    }
  }
}

export function collectSessionWorkAdmissionKeysFromSnapshot(
  store: Record<string, SessionEntry>,
  identities: readonly string[],
): Set<string> {
  if (identities.length === 0) {
    return new Set();
  }
  const active = new Set(identities);
  const normalized = new Set(identities.map(normalizeStoreSessionKey));
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(store)) {
    const normalizedKey = normalizeStoreSessionKey(key);
    if (normalized.has(normalizedKey) || active.has(entry.sessionId)) {
      keys.add(key);
      keys.add(normalizedKey);
    }
  }
  return keys;
}

/** Resolve parent-owned protection against the worker's current row projection. */
export function resolveSessionMaintenancePreserveKeys(params: {
  snapshot: SessionMaintenancePreservationSnapshot;
  store: Record<string, SessionEntry>;
  baseKeys?: Iterable<string | undefined>;
}): Set<string> {
  const keys = new Set(params.snapshot.providerKeys);
  addSessionMaintenancePreserveKeys(keys, params.baseKeys);
  for (const key of collectSessionWorkAdmissionKeysFromSnapshot(
    params.store,
    params.snapshot.workIdentities,
  )) {
    keys.add(key);
  }
  if (params.snapshot.lifecycleIdentities.length > 0) {
    const lifecycle = new Set(params.snapshot.lifecycleIdentities);
    for (const [key, entry] of Object.entries(params.store)) {
      const normalizedKey = normalizeStoreSessionKey(key);
      if (
        [key, normalizedKey, entry.sessionId].some(
          (identity) => Boolean(identity?.trim()) && lifecycle.has(identity.trim()),
        )
      ) {
        keys.add(key);
        keys.add(normalizedKey);
      }
    }
  }
  return keys;
}
