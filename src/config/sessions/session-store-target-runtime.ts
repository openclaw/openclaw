import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "../../state/openclaw-agent-db-registry-listing.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import {
  targetDiscoveryLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { listConfiguredSessionStoreAgentIds } from "./targets-configured-agents.js";

type PreparedStoreTarget = Extract<SessionStoreTargetReadResult, { kind: "session-store-target" }>;
type StoreTargetReadOwner = {
  assertCurrent: () => void;
  onRegistryChange: (change: AgentDatabaseRegistryChange) => void;
  refreshBeforeDispatch: (assertRetainedTarget: () => void) => Promise<void>;
  revalidateTarget: () => Promise<void>;
};

type PreparedInventory = Extract<
  SessionStoreTargetInventoryResult,
  { kind: "session-target-inventory" }
>;
type PreparedSelection = PreparedStoreTarget | PreparedInventory;
type SelectionMemo<Value> = Map<string, { registry: symbol; value: Value }>;
const targetSelections: SelectionMemo<PreparedStoreTarget> = new Map();
const targetInventories: SelectionMemo<PreparedInventory> = new Map();
const MAX_SELECTIONS = 128;

/** Registry receipts and physical replacement invalidate locator facts, never caller authority. */
function captureSelectionMemo<Value extends PreparedSelection>(
  selections: SelectionMemo<Value>,
  request: Pick<SessionStoreTargetReadRequest, "env" | "candidates">,
  selection: unknown,
  includeRows = false,
) {
  const registry = readOpenClawAgentDatabaseRegistryToken({ env: request.env });
  const key = () => {
    try {
      return JSON.stringify([
        selection,
        request.candidates.map((candidate) => {
          const identity = readDatabasePathIdentitySync(candidate.path);
          return [
            candidate,
            identity.key,
            identity.birthtime,
            includeRows ? readSqliteDatabaseWriteTokenForPath(candidate.path) : undefined,
          ];
        }),
      ]);
    } catch {
      // Unreadable candidates retain the discovery owner's normal error path.
      return undefined;
    }
  };
  // Family custody does not enumerate every row source an inventory can discover.
  const captured =
    includeRows && request.candidates.some((candidate) => candidate.scope) ? undefined : key();
  return {
    read(): Value | undefined {
      if (!captured) {
        return undefined;
      }
      const cached = selections.get(captured);
      if (!cached || cached.registry !== registry) {
        return undefined;
      }
      selections.delete(captured);
      selections.set(captured, cached);
      return structuredClone(cached.value);
    },
    install(value: Value): void {
      if (!captured) {
        return;
      }
      selections.delete(captured);
      selections.set(captured, { registry, value: structuredClone(value) });
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
          const memo = captureSelectionMemo(
            targetInventories,
            request,
            [
              request.selection,
              request.agentIds,
              request.config.session?.store,
              request.config.agents?.defaults?.sessionStore?.agentId,
              resolveSessionStoreCompatibilityAgentId(request.config),
              listConfiguredSessionStoreAgentIds(request.config),
              [...request.paths],
              request.registryDiscovery,
            ],
            true,
          );
          let inventory =
            memo.read() ??
            (await discovery.readTargetInventory({
              ...prepared,
              registeredDatabases: registeredDatabases ?? { status: "deferred" },
            }));
          if (inventory.kind === "session-target-registry-required") {
            const { result } = await registry.read();
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
        request.agentId,
        request.defaultAgentId,
        request.storePath,
      ]);
      const cached = memo.read();
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
      memo.install(read.value);
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
