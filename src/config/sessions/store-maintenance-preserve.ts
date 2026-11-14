// Maintenance preserve providers protect runtime-owned sessions from pruning/capping.
import { iterateProjectedAgentRunSessionKeys } from "../../infra/agent-run-projection.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-run-registry.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import {
  collectSessionControllerTargets,
  collectSessionMutationIdentities,
} from "../../sessions/session-controller.lifecycle.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../../state/openclaw-agent-db.paths.js";
import { preparePersonalSessionPins } from "../../state/user-preferences-session-pins.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  addSessionMaintenancePreserveKeys,
  collectSessionWorkAdmissionKeysFromSnapshot,
  resolveSessionMaintenancePreserveKeys,
} from "./store-maintenance-preserve-snapshot.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import type { SessionEntry } from "./types.js";

type PreparedSessionMaintenancePreserveKeys = {
  capture(): Iterable<string> | undefined;
  refreshCandidates?(sessionKeys: readonly string[]): Iterable<string> | undefined;
  /** Release prepared source custody; this must not throw. */
  dispose(): void;
};

type PrepareSessionMaintenancePreserveKeys = (options: {
  native?: boolean;
}) => Promise<PreparedSessionMaintenancePreserveKeys>;

export type PreparedSessionMaintenancePreservation = {
  capture(
    this: void,
    operation?: RetainedWorkerTransactionAdmission,
  ): SessionMaintenancePreservationSnapshot;
  refreshCandidates(
    this: void,
    sessionKeys: readonly string[],
  ): SessionMaintenancePreservationSnapshot;
  dispose(this: void): void;
};

const preserveKeysProviders = new Set<{ prepare: PrepareSessionMaintenancePreserveKeys }>();

/** Registers a provider for session maintenance preserve keys. */
export function registerSessionMaintenancePreserveKeysProvider(
  prepare: PrepareSessionMaintenancePreserveKeys,
): () => void {
  const registration = { prepare };
  preserveKeysProviders.add(registration);
  return () => {
    preserveKeysProviders.delete(registration);
  };
}

/** Resolves store keys owned by active work, including aliases sharing a backing session id. */
export function collectActiveSessionWorkAdmissionKeys(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Set<string> | undefined {
  const keys = collectSessionWorkAdmissionKeysFromSnapshot(params.store, [
    ...(collectSessionControllerTargets(undefined, params.storePath).get(params.storePath) ?? []),
  ]);
  return keys.size > 0 ? keys : undefined;
}

/** Prepare storage-backed providers before workers acquire their transaction permit. */
export async function prepareSessionMaintenancePreservation(
  storePath: string,
  options: { native?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<PreparedSessionMaintenancePreservation> {
  const target = resolveExplicitIncognitoAgentSqliteTarget(storePath, { env: options.env });
  const personalPins = await preparePersonalSessionPins({ env: target?.env ?? options.env });
  const registrations = [...preserveKeysProviders];
  const prepared: PreparedSessionMaintenancePreserveKeys[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const facts of prepared.toReversed()) {
      facts.dispose();
    }
  };
  const assertProvidersCurrent = () => {
    if (disposed) {
      throw new Error("Session maintenance preparation was released");
    }
    if (
      preserveKeysProviders.size !== registrations.length ||
      registrations.some((registration) => !preserveKeysProviders.has(registration))
    ) {
      throw new SqliteSessionMutationConflictError("session maintenance");
    }
  };
  try {
    for (const registration of registrations) {
      prepared.push(await registration.prepare(options));
      assertProvidersCurrent();
    }
    const capture = (
      sessionKeys?: readonly string[],
      operation?: RetainedWorkerTransactionAdmission,
    ): SessionMaintenancePreservationSnapshot => {
      assertProvidersCurrent();
      if (!personalPins.isCurrent()) {
        throw new SqliteSessionMutationConflictError("personal session pins changed");
      }
      if (operation) {
        personalPins.retainOperation(operation);
      }
      const keys = new Set<string>(personalPins.sessionKeys);
      addSessionMaintenancePreserveKeys(
        keys,
        iterateProjectedAgentRunSessionKeys(buildProjectedAgentRunIndex()),
      );
      for (const facts of prepared) {
        const values =
          sessionKeys !== undefined && facts.refreshCandidates
            ? facts.refreshCandidates(sessionKeys)
            : facts.capture();
        addSessionMaintenancePreserveKeys(keys, values);
      }
      assertProvidersCurrent();
      return {
        providerKeys: [...keys].toSorted(),
        workIdentities: [
          ...(collectSessionControllerTargets(undefined, storePath).get(storePath) ?? []),
        ].toSorted(),
        lifecycleIdentities: collectSessionMutationIdentities(storePath),
      };
    };
    return {
      dispose,
      capture: (operation) => capture(undefined, operation),
      refreshCandidates: capture,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Collects runtime, active-work, and lifecycle keys protected from automatic maintenance. */
export async function collectSessionMaintenancePreserveKeysForStore(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  baseKeys?: Iterable<string | undefined>;
}): Promise<Set<string> | undefined> {
  const prepared = await prepareSessionMaintenancePreservation(params.storePath);
  try {
    const keys = resolveSessionMaintenancePreserveKeys({
      ...params,
      snapshot: prepared.capture(),
    });
    return keys.size > 0 ? keys : undefined;
  } finally {
    prepared.dispose();
  }
}
