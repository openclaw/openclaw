// Maintenance preserve providers protect runtime-owned sessions from pruning/capping.
import {
  collectActiveSessionWorkAdmissions,
  collectActiveSessionLifecycleMutationIdentities,
} from "../../sessions/session-lifecycle-admission.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import {
  collectSessionWorkAdmissionKeysFromSnapshot,
  resolveSessionMaintenancePreserveKeys,
  type SessionMaintenancePreservationSnapshot,
} from "./store-maintenance-preserve-snapshot.js";
import type { SessionEntry } from "./types.js";

/** Provider hook for session keys that maintenance/pruning should preserve. */
type SessionMaintenancePreserveKeysProvider = () => Iterable<string> | undefined;

const preserveKeysProviders = new Set<SessionMaintenancePreserveKeysProvider>();

/** Registers a provider for session maintenance preserve keys. */
export function registerSessionMaintenancePreserveKeysProvider(
  provider: SessionMaintenancePreserveKeysProvider,
): () => void {
  preserveKeysProviders.add(provider);
  return () => {
    preserveKeysProviders.delete(provider);
  };
}

function addSessionMaintenancePreserveKeys(
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

/** Collects normalized session keys that maintenance/pruning must preserve. */
export function collectSessionMaintenancePreserveKeys(
  baseKeys?: Iterable<string | undefined>,
): Set<string> | undefined {
  const keys = new Set<string>();
  addSessionMaintenancePreserveKeys(keys, baseKeys);
  for (const provider of preserveKeysProviders) {
    try {
      addSessionMaintenancePreserveKeys(keys, provider());
    } catch {
      // Maintenance must remain best-effort if a runtime provider is temporarily unavailable.
    }
  }
  return keys.size > 0 ? keys : undefined;
}

/** Resolves store keys owned by active work, including aliases sharing a backing session id. */
export function collectActiveSessionWorkAdmissionKeys(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Set<string> | undefined {
  const keys = collectSessionWorkAdmissionKeysFromSnapshot(params.store, [
    ...(collectActiveSessionWorkAdmissions().get(params.storePath) ?? []),
  ]);
  return keys.size > 0 ? keys : undefined;
}

/** Capture live parent owners before dispatch; no protection registry is copied into the worker. */
export function captureSessionMaintenancePreservation(
  storePath: string,
): SessionMaintenancePreservationSnapshot {
  return {
    providerKeys: [...(collectSessionMaintenancePreserveKeys() ?? [])].toSorted(),
    workIdentities: [...(collectActiveSessionWorkAdmissions().get(storePath) ?? [])].toSorted(),
    lifecycleIdentities: collectActiveSessionLifecycleMutationIdentities(storePath),
  };
}

/** Collects runtime, active-work, and lifecycle keys protected from automatic maintenance. */
export function collectSessionMaintenancePreserveKeysForStore(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  baseKeys?: Iterable<string | undefined>;
}): Set<string> | undefined {
  const keys = resolveSessionMaintenancePreserveKeys({
    ...params,
    snapshot: captureSessionMaintenancePreservation(params.storePath),
  });
  return keys.size > 0 ? keys : undefined;
}
