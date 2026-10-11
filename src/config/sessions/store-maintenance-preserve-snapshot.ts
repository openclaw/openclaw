import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  MaintenancePreservationRequiredError,
  SqliteSessionMutationConflictError,
} from "./session-mutation-conflict-error.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import type { SessionEntry } from "./types.js";

export function readSessionMaintenancePreservation(
  snapshot: SessionMaintenancePreservationSnapshot | null,
): SessionMaintenancePreservationSnapshot {
  if (snapshot === null) {
    throw new MaintenancePreservationRequiredError(
      "SQLite maintenance requires session preservation",
    );
  }
  return snapshot;
}

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

export function assertMaintenancePreservationCompatible(
  sent: SessionMaintenancePreservationSnapshot,
  current: SessionMaintenancePreservationSnapshot,
  plans?: readonly SessionEntryMaintenancePlan[],
): void {
  const added = new Set(
    (["providerKeys", "workIdentities", "lifecycleIdentities"] as const).flatMap((kind) => {
      const previous = new Set(sent[kind].map((id) => id.trim()));
      return current[kind]
        .flatMap((id) => (previous.has(id.trim()) ? [] : [id.trim(), normalizeStoreSessionKey(id)]))
        .filter(Boolean);
    }),
  );
  // Lost protection only over-preserves the sent plan, so it cannot invalidate a commit.
  if (added.size === 0) {
    return;
  }
  // Matching provider keys against session IDs only makes rare conflicts more conservative.
  const protectsRow = (sessionKey: string, sessionId?: string) =>
    added.has(sessionKey.trim()) ||
    added.has(normalizeStoreSessionKey(sessionKey)) ||
    (sessionId && added.has(sessionId.trim()));
  if (
    !plans ||
    plans.some(
      (plan) =>
        plan.entryRemovals.some((row) =>
          protectsRow(row.sessionKey, row.expectedEntry?.sessionId),
        ) ||
        plan.archivedEntries.some((row) => protectsRow(row.sessionKey, row.sessionId)) ||
        plan.stateDeletePlans.some((row) => protectsRow("", row.sessionId)),
    )
  ) {
    throw new SqliteSessionMutationConflictError("session maintenance");
  }
}
