// Maintenance preserve providers protect runtime-owned sessions from pruning/capping.
import type { SubagentMaintenanceDurableBasis } from "../../agents/subagents/registry/subagent-registry-read.types.js";
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

export type PreparedSessionMaintenancePreserveKeys = {
  capture(): Iterable<string> | undefined;
  /** Release prepared source custody; this must not throw. */
  dispose(): void;
  readonly subagentRunBasis?: SubagentMaintenanceDurableBasis;
};

type PrepareSessionMaintenancePreserveKeys = () => Promise<PreparedSessionMaintenancePreserveKeys>;

const preserveKeysProviders = new Map<
  SessionMaintenancePreserveKeysProvider,
  { prepare?: PrepareSessionMaintenancePreserveKeys }
>();

/** Registers a provider for session maintenance preserve keys. */
export function registerSessionMaintenancePreserveKeysProvider(
  provider: SessionMaintenancePreserveKeysProvider,
  prepare?: PrepareSessionMaintenancePreserveKeys,
): () => void {
  preserveKeysProviders.set(provider, { prepare });
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
  for (const provider of preserveKeysProviders.keys()) {
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

/** Prepare storage-backed providers before workers acquire their transaction permit. */
export async function prepareSessionMaintenancePreservation(storePath: string): Promise<{
  capture(): SessionMaintenancePreservationSnapshot;
  dispose(): void;
  readonly subagentRunBasis?: SubagentMaintenanceDurableBasis;
}> {
  const registrations = [...preserveKeysProviders];
  const prepared: Array<{
    provider: SessionMaintenancePreserveKeysProvider;
    facts?: PreparedSessionMaintenancePreserveKeys;
  }> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const { facts } of prepared.toReversed()) {
      facts?.dispose();
    }
  };
  const assertProvidersCurrent = () => {
    if (disposed) {
      throw new Error("Session maintenance preparation was released");
    }
    if (
      preserveKeysProviders.size !== registrations.length ||
      registrations.some(
        ([provider, registration]) => preserveKeysProviders.get(provider) !== registration,
      )
    ) {
      throw new Error("Session maintenance providers changed during preparation");
    }
  };
  try {
    for (const [provider, registration] of registrations) {
      prepared.push({
        provider,
        facts: registration.prepare ? await registration.prepare() : undefined,
      });
      assertProvidersCurrent();
    }
    const bases = prepared.flatMap(({ facts }) =>
      facts?.subagentRunBasis ? [facts.subagentRunBasis] : [],
    );
    if (bases.length > 1) {
      throw new Error("Session maintenance has competing subagent registry providers");
    }
    return {
      subagentRunBasis: bases[0],
      dispose,
      capture() {
        assertProvidersCurrent();
        const keys = new Set<string>();
        for (const { provider, facts } of prepared) {
          addSessionMaintenancePreserveKeys(keys, facts ? facts.capture() : provider());
        }
        assertProvidersCurrent();
        return {
          providerKeys: [...keys].toSorted(),
          workIdentities: [
            ...(collectActiveSessionWorkAdmissions().get(storePath) ?? []),
          ].toSorted(),
          lifecycleIdentities: collectActiveSessionLifecycleMutationIdentities(storePath),
        };
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
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
