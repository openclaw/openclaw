import { resolveIdentityPathViaExistingAncestor } from "../../infra/boundary-path.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import type { SessionStoreWorkerReadScope } from "./session-entry-read-runtime.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
import type { SessionStoreReadCustody } from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import type { SessionStoreTargetInventoryRequest } from "./session-store-target-routing.js";
import {
  targetDiscoveryLane,
  prepareSessionStoreCandidatesInWorker,
  withSessionHistoryWorkerReadCandidates,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";

type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
type PreparedStoreTarget = DeepReadonly<
  Extract<SessionStoreTargetReadResult, { kind: "session-store-target" }>
>;
type StoreTargetReadOwner = {
  readCustody: SessionStoreReadCustody;
  assertCurrent: () => void;
  onRegistryChange: (change: AgentDatabaseRegistryChange) => void;
  refreshBeforeDispatch: (assertRetainedTarget: () => void) => Promise<void>;
  revalidateTarget: () => Promise<void>;
};

type PreparedInventory = DeepReadonly<
  Extract<SessionStoreTargetInventoryResult, { kind: "session-target-inventory" }>
>;
export function prepareSessionStoreTargetInventoryRead(
  request: Omit<SessionStoreTargetInventoryRequest, "registeredDatabases">,
  unchangedBy?: Parameters<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>[1],
  registeredDatabases?: SessionStoreRegistryRead,
  registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: request.env }, unchangedBy),
) {
  const { candidates, ...prepared } = request;
  // Security-scoped inventories can supply a stricter witness. Ordinary discovery
  // keeps its selected registry snapshot; later registrations affect the next read.
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
  signal?: AbortSignal,
  lane: SessionHistoryWorkerLane = targetDiscoveryLane,
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
      let read = await discovery.readStoreTargetResult({
        ...targetRequest,
        registeredDatabases: { status: "deferred" },
      });
      if (read.ok && read.value.kind === "session-target-registry-required") {
        const { result } = await registry.read(signal);
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
      const target = read.value;
      return operation(target, {
        readCustody: { sourcePath: target.sourcePath, candidates },
        assertCurrent,
        onRegistryChange: registry.assertAdmissionCurrent,
        async refreshBeforeDispatch(assertRetainedTarget) {
          assertRetainedTarget();
          assertCurrent();
        },
        async revalidateTarget() {
          await prepareSessionStoreCandidatesInWorker({
            validate: {
              readCustody: [{ sourcePath: target.sourcePath, candidates }],
              candidates: [],
              sources: [],
            },
          });
          assertCurrent();
        },
      });
    },
    lane,
    signal,
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
  if (source) {
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
  const candidates =
    !options.inspection && (target.agentId || target.shared)
      ? [
          {
            path: target.path,
            physicalPath: await resolveIdentityPathViaExistingAncestor(target.path),
          },
        ]
      : (
          await prepareSessionStoreCandidatesInWorker({
            storePath,
            ...(!options.inspection ? { captureIdentity: false as const } : {}),
          })
        ).candidates;
  const direct =
    !options.inspection && options.allowDirect && target.agentId
      ? candidates.find(
          (candidate) => !candidate.scope && candidate.path === candidate.physicalPath,
        )
      : undefined;
  return { target, direct, candidates };
}
