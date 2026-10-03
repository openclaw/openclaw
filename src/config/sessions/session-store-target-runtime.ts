import { isDeepStrictEqual } from "node:util";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  AgentDatabaseRegistryChangedError,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  type AgentDatabaseRegistryChange,
} from "../../state/openclaw-agent-db-registry-listing.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import {
  createSessionStoreRegistryMutationFilter,
  type SessionStoreTargetInventoryRequest,
  type SessionStoreTargetInventoryResult,
  type SessionStoreTargetReadRequest,
  type SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import {
  withSessionHistoryWorkerReadCandidates,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";

type PreparedStoreTarget = Extract<SessionStoreTargetReadResult, { kind: "session-store-target" }>;
type StoreTargetReadOwner = {
  assertCurrent: () => void;
  onRegistryChange: (change: AgentDatabaseRegistryChange) => void;
  refreshBeforeDispatch: (assertRetainedTarget: () => void) => Promise<void>;
  revalidateTarget: () => Promise<void>;
};

function prepareSessionStoreRegistryRead(
  request: Pick<SessionStoreTargetInventoryRequest, "env" | "candidates" | "registryDiscovery">,
  unchangedBy?: Parameters<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>[1],
) {
  return prepareOpenClawAgentDatabaseRegistrySnapshotRead(
    { env: request.env },
    unchangedBy ??
      createSessionStoreRegistryMutationFilter({
        captured: request.candidates.map((candidate) => {
          const identity = readDatabasePathIdentitySync(candidate.path);
          return { candidate, identity: identity.key, birthtime: identity.birthtime };
        }),
        preparedSources: [],
        registryDiscovery: request.registryDiscovery,
      }),
  );
}

/** Capture registry admission now; retain its witness independently of discovery custody. */
export function prepareSessionStoreTargetInventoryRead(
  request: Omit<SessionStoreTargetInventoryRequest, "registeredDatabases">,
  unchangedBy?: Parameters<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>[1],
) {
  const { candidates, ...prepared } = request;
  const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
    { env: request.env },
    unchangedBy,
  );
  let registryStarted = false;
  const assertRegistryCurrent = () => {
    // Explicit publication scopes retain their witness before discovery; other
    // inventories depend on registry currency only after requesting its rows.
    if (registryStarted || unchangedBy) {
      registry.assertCurrent();
    }
  };
  return {
    assertRegistryCurrent,
    withRead<T>(
      operation: (
        inventory: Extract<SessionStoreTargetInventoryResult, { kind: "session-target-inventory" }>,
        assertCurrent: () => void,
      ) => Promise<T>,
      assertCallerCurrent?: () => void,
    ) {
      return withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
        const assertCurrent = () => {
          assertCallerCurrent?.();
          discovery.assertCurrent();
          assertRegistryCurrent();
        };
        let inventory = await discovery.readTargetInventory({
          ...prepared,
          registeredDatabases: { status: "deferred" },
        });
        assertCurrent();
        if (inventory.kind === "session-target-registry-required") {
          registryStarted = true;
          const current = await registry.read();
          assertCurrent();
          inventory = await discovery.readTargetInventory({
            ...prepared,
            registeredDatabases:
              current.result.status === "available"
                ? current.result.entries
                : { status: "unavailable" },
          });
          assertCurrent();
        }
        if (inventory.kind !== "session-target-inventory") {
          throw new Error("Session store inventory requested registry rows twice");
        }
        return operation(inventory, assertCurrent);
      });
    },
  };
}

export async function withSessionStoreTarget<T>(
  request: Omit<SessionStoreTargetReadRequest, "registeredDatabases">,
  operation: (target: PreparedStoreTarget, owner: StoreTargetReadOwner) => Promise<T>,
  assertCallerCurrent?: () => void,
  onReadError?: (error: unknown, assertCurrent: () => void) => Promise<T>,
  { lane }: { lane?: SessionHistoryWorkerLane } = {},
): Promise<T> {
  assertCallerCurrent?.();
  const { candidates, ...targetRequest } = request;
  let registryRead = prepareSessionStoreRegistryRead(request);
  return withSessionHistoryWorkerReadCandidates(
    candidates,
    async (discovery) => {
      const assertDiscoveryCurrent = () => {
        assertCallerCurrent?.();
        discovery.assertCurrent();
        registryRead.assertCurrent();
      };
      const failedRead = async (error: unknown): Promise<T> => {
        assertDiscoveryCurrent();
        if (!onReadError) {
          throw error;
        }
        return await onReadError(error, assertDiscoveryCurrent);
      };
      let read = await discovery.readStoreTargetResult({
        ...targetRequest,
        registeredDatabases: { status: "deferred" },
      });
      if (!read.ok) {
        return await failedRead(read.error);
      }
      let resolved = read.value;
      let registry: Awaited<ReturnType<typeof registryRead.read>> | undefined;
      if (resolved.kind === "session-target-registry-required") {
        registryRead.assertCurrent();
        registry = await registryRead.read();
        assertDiscoveryCurrent();
        read = await discovery.readStoreTargetResult({
          ...targetRequest,
          registeredDatabases:
            registry.result.status === "available"
              ? registry.result.entries
              : { status: "unavailable" },
        });
        if (!read.ok) {
          return await failedRead(read.error);
        }
        resolved = read.value;
        if (resolved.kind === "session-target-registry-required") {
          throw new Error("Session store target requested registry rows twice");
        }
      }
      const target = resolved;
      const assertSourceCurrent = () => {
        assertCallerCurrent?.();
        discovery.assertCurrent();
        assertSessionStoreReadCandidate(target.sourcePath, candidates);
      };
      const assertCurrent = () => {
        assertSourceCurrent();
        registryRead.assertCurrent();
      };
      let registrationChanged = false;
      const verifyCurrentTarget = async (assertRetainedCurrent: () => void) => {
        assertRetainedCurrent();
        const currentRead = prepareSessionStoreRegistryRead(request);
        const currentRegistry = await currentRead.read();
        assertRetainedCurrent();
        currentRegistry.assertCurrent();
        const current = await discovery.readStoreTargetResult({
          ...targetRequest,
          registeredDatabases:
            currentRegistry.result.status === "available"
              ? currentRegistry.result.entries
              : { status: "unavailable" },
        });
        if (!current.ok) {
          throw current.error;
        }
        assertRetainedCurrent();
        currentRegistry.assertCurrent();
        if (!isDeepStrictEqual(current.value, target)) {
          throw new Error("Session store registration changed its selected target");
        }
        registryRead = currentRead;
        registry = currentRegistry;
        registrationChanged = false;
      };
      assertCurrent();
      // A synchronous consumer may already publish; its operation owns the final currentness check.
      const result = await operation(target, {
        assertCurrent,
        onRegistryChange(change) {
          if (registry) {
            registry.followRegistration(change);
            registrationChanged = true;
          }
        },
        async refreshBeforeDispatch(assertRetainedTarget) {
          try {
            assertCurrent();
          } catch (error) {
            if (!(error instanceof AgentDatabaseRegistryChangedError)) {
              throw error;
            }
            // A preceding writer may register this same store while admission waits.
            await verifyCurrentTarget(() => {
              assertSourceCurrent();
              assertRetainedTarget();
            });
          }
        },
        async revalidateTarget() {
          assertCurrent();
          if (registrationChanged) {
            await verifyCurrentTarget(assertCurrent);
          }
        },
      });
      if (registrationChanged) {
        throw new Error("Session read released its owner before confirming registration");
      }
      return result;
    },
    lane,
  );
}
