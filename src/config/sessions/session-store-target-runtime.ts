import {
  getSqliteDatabaseAdmissionIdentityForPath,
  readSqliteDatabaseWriteTokenForPath,
} from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "../../state/openclaw-agent-db-registry-listing.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { SessionStoreWorkerReadScope } from "./session-entry-read-runtime.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import {
  targetDiscoveryLane,
  prepareSessionStoreCandidatesInWorker,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { listConfiguredSessionStoreAgentIds } from "./targets-configured-agents.js";

type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
type PreparedStoreTarget = DeepReadonly<
  Extract<SessionStoreTargetReadResult, { kind: "session-store-target" }>
>;
type StoreTargetReadOwner = {
  assertCurrent: () => void;
  onRegistryChange: (change: AgentDatabaseRegistryChange) => void;
  refreshBeforeDispatch: (assertRetainedTarget: () => void) => Promise<void>;
  revalidateTarget: () => Promise<void>;
};

type PreparedInventory = DeepReadonly<
  Extract<SessionStoreTargetInventoryResult, { kind: "session-target-inventory" }>
>;
type SelectionMemo<Value> = Map<string, { registry: symbol; value: Value }>;
const targetSelections: SelectionMemo<PreparedStoreTarget> = new Map();
const targetInventories: SelectionMemo<PreparedInventory> = new Map();
const MAX_SELECTIONS = 128;

/** Memo keys track supplied physical identities; in-process registry publications retire entries.
 * Family markers alone do not witness external changes. Neither memo grants caller authority. */
function captureSelectionMemo<Value>(
  selections: SelectionMemo<Value>,
  request: Pick<SessionStoreTargetReadRequest, "env" | "candidates">,
  selection: unknown,
  includeRows = false,
) {
  const registry = readOpenClawAgentDatabaseRegistryToken({ env: request.env });
  let captured: string | undefined;
  try {
    // Family custody does not enumerate every row source an inventory can discover.
    if (!includeRows || !request.candidates.some((candidate) => candidate.scope)) {
      captured = JSON.stringify([
        selection,
        request.candidates.map((candidate) => {
          if (candidate.scope && isArtifactPreservingStateRead("agent")) {
            return [candidate];
          }
          const identity = candidate.identity ?? readDatabasePathIdentitySync(candidate.path);
          return [
            candidate,
            identity.key,
            identity.birthtime,
            includeRows &&
            (!candidate.identity || getSqliteDatabaseAdmissionIdentityForPath(candidate.path))
              ? readSqliteDatabaseWriteTokenForPath(candidate.path)
              : undefined,
          ];
        }),
      ]);
    }
  } catch {
    // Unreadable candidates retain the discovery owner's normal error path.
  }
  const cached = captured ? selections.get(captured) : undefined;
  if (captured && cached?.registry === registry) {
    selections.delete(captured);
    selections.set(captured, cached);
  }
  return {
    value: cached?.registry === registry ? cached.value : undefined,
    install(value: Value): void {
      if (!captured) {
        return;
      }
      selections.delete(captured);
      selections.set(captured, { registry, value: freezeTrustedJsonSnapshot(value) });
      while (selections.size > MAX_SELECTIONS) {
        selections.delete(selections.keys().next().value!);
      }
    },
  };
}

export function prepareSessionStoreTargetInventoryRead(
  request: Omit<SessionStoreTargetInventoryRequest, "registeredDatabases">,
  unchangedBy?: Parameters<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>[1],
  registeredDatabases?: SessionStoreRegistryRead,
) {
  const { candidates, ...prepared } = request;
  const selection = [
    request.preserveSourceArtifacts,
    request.selection,
    request.recoveryExclusions,
    request.agentIds,
    request.config.session?.store,
    request.config.agents?.defaults?.sessionStore?.agentId,
    resolveSessionStoreCompatibilityAgentId(request.config),
    listConfiguredSessionStoreAgentIds(request.config),
    [...request.paths],
    request.registryDiscovery,
  ];
  // Security-scoped inventories can supply a stricter witness. Ordinary discovery
  // keeps its selected registry snapshot; later registrations affect the next read.
  const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
    { env: request.env },
    unchangedBy,
  );
  const assertRegistryCurrent = unchangedBy
    ? registry.assertCurrent
    : registry.assertAdmissionCurrent;
  return {
    assertRegistryCurrent,
    followRegistration: registry.followRegistration,
    withRead<T>(
      operation: (inventory: PreparedInventory, assertCurrent: () => void) => Promise<T>,
      assertCallerCurrent?: () => void,
      signal?: AbortSignal,
    ) {
      return withSessionHistoryWorkerReadCandidates(
        candidates,
        async (discovery) => {
          const assertCurrent = () => {
            signal?.throwIfAborted();
            assertCallerCurrent?.();
            discovery.assertCurrent();
            assertRegistryCurrent();
          };
          const memo = captureSelectionMemo(
            targetInventories,
            request,
            selection,
            // Only fixed-store visibility depends on the session rows. Per-agent
            // topology changes with physical files or registry ownership, not activity.
            !isPerAgentSessionStoreConfig(request.config.session?.store),
          );
          if (memo.value) {
            assertCurrent();
            return operation(memo.value, assertCurrent);
          }
          let inventory = await discovery.readTargetInventory({
            ...prepared,
            registeredDatabases: registeredDatabases ?? { status: "deferred" },
          });
          if (inventory.kind === "session-target-registry-required") {
            const { result } = await registry.read(signal);
            inventory = await discovery.readTargetInventory({
              ...prepared,
              registeredDatabases:
                result.status === "available" ? result.entries : { status: "unavailable" },
            });
          }
          assertCurrent();
          if (inventory.kind !== "session-target-inventory") {
            throw new Error("Session store inventory requested registry rows twice");
          }
          if (inventory.agents.every((agent) => agent.result.available)) {
            memo.install(inventory);
          }
          return operation(inventory, assertCurrent);
        },
        targetDiscoveryLane,
        signal,
      );
    },
  };
}

export async function withSessionStoreTarget<T>(
  request: Omit<SessionStoreTargetReadRequest, "registeredDatabases">,
  operation: (target: PreparedStoreTarget, owner: StoreTargetReadOwner) => Promise<T>,
  assertCallerCurrent?: () => void,
  onReadError?: (error: unknown, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  assertCallerCurrent?.();
  const { candidates, ...targetRequest } = {
    ...request,
    ...(isArtifactPreservingStateRead("agent") ? { preserveSourceArtifacts: true as const } : {}),
  };
  const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: request.env });
  return withSessionHistoryWorkerReadCandidates(
    candidates,
    async (discovery) => {
      const assertCurrent = () => {
        assertCallerCurrent?.();
        registry.assertAdmissionCurrent();
        discovery.assertCurrent();
      };
      const memo = captureSelectionMemo(targetSelections, request, [
        targetRequest.preserveSourceArtifacts,
        request.agentId,
        request.defaultAgentId,
        request.storePath,
      ]);
      const cached = memo.value;
      let read = cached
        ? { ok: true as const, value: cached }
        : await discovery.readStoreTargetResult({
            ...targetRequest,
            registeredDatabases: { status: "deferred" },
          });
      if (read.ok && read.value.kind === "session-target-registry-required") {
        const { result } = await registry.read();
        read = await discovery.readStoreTargetResult({
          ...targetRequest,
          registeredDatabases:
            result.status === "available" ? result.entries : { status: "unavailable" },
        });
      }
      assertCurrent();
      if (!read.ok) {
        if (onReadError) {
          return onReadError(read.error, assertCurrent);
        }
        throw read.error;
      }
      if (read.value.kind === "session-target-registry-required") {
        throw new Error("Session store target requested registry rows twice");
      }
      if (!cached) {
        memo.install(read.value);
      }
      const target = read.value;
      const assertTargetCurrent = () => {
        assertCurrent();
        assertSessionStoreReadCandidate(target.sourcePath, candidates);
      };
      return operation(target, {
        assertCurrent: assertTargetCurrent,
        onRegistryChange: registry.assertAdmissionCurrent,
        async refreshBeforeDispatch(assertRetainedTarget) {
          assertRetainedTarget();
          assertTargetCurrent();
        },
        async revalidateTarget() {
          assertTargetCurrent();
        },
      });
    },
    targetDiscoveryLane,
  );
}

/** A live prepared source already owns physical qualification; cold locators use discovery. */
export async function prepareSessionStoreReaderCandidates(
  storePath: string,
  options: {
    inspection: boolean;
    allowDirect: boolean;
    preparedSource?: SessionStoreWorkerReadScope["preparedSource"];
  },
) {
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const source = options.preparedSource;
  if (options.inspection && source) {
    source.assertCurrent();
    return {
      target,
      direct: undefined,
      candidates: [
        {
          path: source.path,
          physicalPath: source.path,
          identity: {
            key: "file:" + source.databaseIdentity,
            canonicalPath: source.path,
            birthtime: source.databaseBirthtime,
          },
        },
      ],
    };
  }
  const captured =
    !options.inspection && options.allowDirect && target.agentId
      ? captureSessionStoreReadCandidate(target.path)
      : undefined;
  const direct = captured && captured.path === captured.physicalPath ? captured : undefined;
  const candidates = options.inspection
    ? (await prepareSessionStoreCandidatesInWorker({ storePath })).candidates
    : direct
      ? [direct]
      : captureSessionStoreReadCandidates(storePath);
  return { target, direct, candidates };
}
