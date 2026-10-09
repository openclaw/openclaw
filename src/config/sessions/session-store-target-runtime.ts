import { isDeepStrictEqual } from "node:util";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  AgentDatabaseRegistryChangedError,
  AgentDatabaseRegistryPendingError,
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
  targetDiscoveryLane,
  withSessionHistoryWorkerReadCandidates,
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
  selectedTarget?: () => PreparedStoreTarget | undefined,
) {
  const captured = request.candidates.map((candidate) => {
    try {
      const identity = readDatabasePathIdentitySync(candidate.path);
      return { candidate, identity: identity.key, birthtime: identity.birthtime };
    } catch {
      // Retain path fencing; the worker owns an unreadable candidate's diagnostic.
      return { candidate, identity: "unavailable" };
    }
  });
  const preparedSources: Array<
    Parameters<typeof createSessionStoreRegistryMutationFilter>[0]["preparedSources"][number]
  > = [];
  const unchangedBy = createSessionStoreRegistryMutationFilter({
    captured,
    preparedSources,
    registryDiscovery: request.registryDiscovery,
  });
  return prepareOpenClawAgentDatabaseRegistrySnapshotRead(
    { env: request.env },
    (mutation, entries) => {
      const target = selectedTarget?.();
      if (target && mutation.kind === "upsert" && preparedSources.length === 0) {
        for (const source of mutation.sources) {
          const absent = captured.find(
            ({ candidate, identity }) =>
              !candidate.scope &&
              identity.startsWith("path:") &&
              candidate.physicalPath === target.database.path,
          );
          if (
            !absent ||
            source.agentId !== target.database.agentId ||
            source.physicalPath !== target.database.path ||
            source.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION
          ) {
            continue;
          }
          try {
            const current = readDatabasePathIdentitySync(absent.candidate.path);
            if (current.key === source.identity && current.birthtime !== undefined) {
              // First registration preserves the selected absent owner; later changes keep its generation.
              absent.identity = current.key;
              absent.birthtime = current.birthtime;
              preparedSources.push({
                ...target.database,
                identity: current.key,
                birthtime: current.birthtime,
              });
              break;
            }
          } catch {
            // An unreadable or replaced source remains a registry invalidation.
          }
        }
      }
      return unchangedBy(mutation, entries);
    },
  );
}

/** Capture registry admission now; retain its witness independently of discovery custody. */
export function prepareSessionStoreTargetInventoryRead(
  request: Omit<SessionStoreTargetInventoryRequest, "registeredDatabases">,
  unchangedBy?: Parameters<typeof prepareOpenClawAgentDatabaseRegistrySnapshotRead>[1],
) {
  const { candidates, ...prepared } = request;
  const captureRegistry = () =>
    prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: request.env }, unchangedBy);
  let registry = captureRegistry();
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
      return withSessionHistoryWorkerReadCandidates(
        candidates,
        async (discovery) => {
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
            let current;
            try {
              current = await registry.read();
            } catch (error) {
              if (!(error instanceof AgentDatabaseRegistryChangedError)) {
                throw error;
              }
              registry = captureRegistry();
              current = await registry.read();
            }
            assertCurrent();
            registry = unchangedBy ? registry : prepareSessionStoreRegistryRead(request);
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
        },
        targetDiscoveryLane,
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
  const { candidates, ...targetRequest } = request;
  let selectedTarget: PreparedStoreTarget | undefined;
  let registryRead = prepareSessionStoreRegistryRead(request, () => selectedTarget);
  const assertRegistryAdmissionCurrent = registryRead.assertAdmissionCurrent;
  return withSessionHistoryWorkerReadCandidates(
    candidates,
    async (discovery) => {
      const assertDiscoveryCurrent = () => {
        assertCallerCurrent?.();
        assertRegistryAdmissionCurrent();
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
      const readTarget = async () => {
        let read = await discovery.readStoreTargetResult({
          ...targetRequest,
          registeredDatabases: { status: "deferred" },
        });
        if (read.ok && read.value.kind === "session-target-registry-required") {
          registryRead.assertCurrent();
          const registry = await registryRead.read();
          assertDiscoveryCurrent();
          read = await discovery.readStoreTargetResult({
            ...targetRequest,
            registeredDatabases:
              registry.result.status === "available"
                ? registry.result.entries
                : { status: "unavailable" },
          });
        }
        if (read.ok && read.value.kind === "session-store-target") {
          selectedTarget = read.value;
        }
        assertDiscoveryCurrent();
        return read;
      };
      let read: Awaited<ReturnType<typeof readTarget>>;
      try {
        read = await readTarget();
      } catch (error) {
        if (!(error instanceof AgentDatabaseRegistryPendingError)) {
          throw error;
        }
        // Join only the first refusal's pending set; later registrations must not prolong admission.
        await error.waitForSettlement();
        assertCallerCurrent?.();
        assertRegistryAdmissionCurrent();
        discovery.assertCurrent();
        selectedTarget = undefined;
        registryRead = prepareSessionStoreRegistryRead(request, () => selectedTarget);
        read = await readTarget();
      }
      if (!read.ok) {
        return await failedRead(read.error);
      }
      if (read.value.kind === "session-target-registry-required") {
        throw new Error("Session store target requested registry rows twice");
      }
      const target = read.value;
      const assertSourceCurrent = () => {
        assertCallerCurrent?.();
        assertRegistryAdmissionCurrent();
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
        registrationChanged = false;
      };
      assertCurrent();
      // A synchronous consumer may already publish; its operation owns the final currentness check.
      const result = await operation(target, {
        assertCurrent,
        onRegistryChange(change) {
          registryRead.followRegistration(change);
          registrationChanged = true;
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
    targetDiscoveryLane,
  );
}
