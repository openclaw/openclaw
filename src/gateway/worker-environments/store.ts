import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { stageRepositoryWorkspacePublication } from "../../state/session-repository-workspaces.publication.js";
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";
import {
  isPreparedReservationWithinCapacity,
  preparedCapacityFromReservations,
  selectPreparedEnvironmentReservations,
} from "./prepared-environment-store.js";
import type { WorkerEnvironmentSessionIdentity } from "./session-attachment.js";
import { isWorkerEnvironmentCommitAdmission } from "./store-commit-authority.js";
import { reconcilePendingWorkerEnvironmentMutations } from "./store-native-publication.js";
import { workerEnvironmentProjections } from "./store-projection.js";
import { normalizeCredentialHash, requireWorkerEnvironmentString } from "./store-validation.js";
import type { WorkerEnvironmentWorkerOperations } from "./store-worker-contract.js";
import type { WorkerEnvironmentPruneInput } from "./store-write-types.js";
import type {
  WorkerRecoveryPublication,
  WorkerEnvironmentFacts,
  WorkerEnvironmentMutationMethods,
  WorkerEnvironmentPruneCursor,
  WorkerEnvironmentPrunePage,
} from "./store.types.js";

export type {
  PreparedEnvironmentPlacementBinding,
  PreparedEnvironmentSelection,
  WorkerEnvironmentRecord,
} from "./environment-record.js";
export type { WorkerEnvironmentTransitionPatch } from "./store-write-types.js";

type Input<Method extends keyof WorkerEnvironmentMutationMethods> = Parameters<
  WorkerEnvironmentMutationMethods[Method]
>[0];
type Operations = WorkerEnvironmentWorkerOperations;

// Native receipts originate in this store's worker; a failed result delivery still owns its facts.
function isInventoryFacts(value: unknown): value is WorkerEnvironmentFacts {
  return (
    isRecord(value) &&
    Array.isArray(value.ids) &&
    value.ids.every((id) => typeof id === "string") &&
    Array.isArray(value.environments) &&
    Array.isArray(value.credentials) &&
    Array.isArray(value.attachments)
  );
}

function isRecoveryPublication(value: unknown): value is WorkerRecoveryPublication {
  if (
    !isRecord(value) ||
    !isRecord(value.workspace) ||
    !isRecord(value.workspace.workspace) ||
    !isRecord(value.placement)
  ) {
    return false;
  }
  const workspace = value.workspace.workspace;
  const placement = value.placement;
  return (
    typeof workspace.workspaceId === "string" &&
    workspace.workspaceId === value.workspace.workspaceId &&
    typeof workspace.revision === "number" &&
    typeof workspace.agentId === "string" &&
    typeof workspace.sessionKey === "string" &&
    placement.state === "reclaimed" &&
    placement.agentId === workspace.agentId &&
    placement.sessionKey === workspace.sessionKey &&
    typeof placement.sessionId === "string" &&
    typeof placement.generation === "number" &&
    placement.turnClaim === null
  );
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  // A refused native open does not retire an admitted worker inventory.
  // Explicit closure and terminal failures still revoke its owner.
  if (event.kind !== "opened" && event.kind !== "open-error") {
    workerEnvironmentProjections.invalidate(event.identity, event.path);
  }
});

export async function createWorkerEnvironmentStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const context = captureOpenClawStateWorkerContext(
    options.database ? { path: options.database.path } : {},
  );
  const pathname = context.admission.databasePath;
  const now = options.now ?? Date.now;
  const owner = workerEnvironmentProjections.acquire(() => context.admission.identity);
  const releaseOwner = owner.retain();
  const revocationSubscriptions = new Set<() => void>();
  const operations = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (closed || !owner.active) {
      throw new Error("Worker environment inventory has closed");
    }
    context.admission.assertCurrent();
  };
  const read = <T>(operation: () => T): T => {
    assertActive();
    return operation();
  };
  async function snapshot(ids?: readonly string[]) {
    const reply = await executeExistingOpenClawStateRead(
      { path: pathname },
      { type: "workerEnvironments.snapshot", ids },
    );
    assertActive();
    if (!reply || !reply.ok || reply.type !== "workerEnvironments.snapshot") {
      throw new Error("Worker environment inventory could not be read");
    }
    return reply.facts;
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }
  const reconcilePending = () =>
    reconcilePendingWorkerEnvironmentMutations({
      owner,
      assertCurrent: assertActive,
      snapshot,
    });
  function mutate<Key extends keyof Operations>(
    type: Key,
    input: Operations[Key]["input"],
    assertCurrent: () => void = () => {},
    revocationId?: string,
  ): Promise<Operations[Key]["output"]["result"]> {
    assertActive();
    if (closing) {
      throw new Error("Worker environment inventory is closing");
    }
    const captured = structuredClone({ ...input, nowMs: options.now?.() });
    const operation = owner.enqueue(async () => {
      await reconcilePending();
      const token = {};
      let admission: SqliteWorkerOperationAdmission | undefined;
      let commitSequence: number | undefined;
      let committedIds: readonly string[] = [];
      let revocationPublished = false;
      let recovery: WorkerRecoveryPublication | undefined;
      let workspacePublication: ReturnType<typeof stageRepositoryWorkspacePublication> | undefined;
      let placementPublication:
        | ReturnType<typeof stagePlacementTurnClaimWorkerPublication>
        | undefined;
      let recoverySettled = false;
      const settleRecovery = (
        committed: boolean,
        known: boolean,
        received?: WorkerRecoveryPublication,
      ) => {
        if (recoverySettled) {
          return;
        }
        if (committed && !isDeepStrictEqual(received, recovery)) {
          throw new Error("Recovery commit postimages changed during settlement");
        }
        recoverySettled = true;
        workspacePublication?.settle(committed, known);
        if (committed) {
          placementPublication?.commit();
        } else if (known) {
          placementPublication?.rollback();
        } else {
          placementPublication?.invalidate();
        }
      };
      const publishRevocation = () => {
        if (revocationId === undefined || revocationPublished) {
          return;
        }
        revocationPublished = true;
        owner.publishCredentialRevoked(revocationId);
      };
      const check = () =>
        owner.withAdmission(token, () => {
          assertActive();
          assertCurrent();
        });
      check();
      try {
        return await runOpenClawStateWorkerOperation(
          context,
          async (scope) => {
            const receipt = await scope.execute({ type, input: captured });
            if (commitSequence === undefined) {
              throw new Error("Worker environment mutation has no commit admission");
            }
            settleRecovery(true, true, receipt.recovery);
            owner.install(receipt.facts, commitSequence, false);
            owner.release(token);
            publishRevocation();
            if (receipt.changed) {
              sessionChanges.emit({ all: true, scope: "worker-environments" });
            }
            return receipt.result;
          },
          {
            assertCurrent: check,
            createAdmission: () => {
              let stage: "transaction" | "commit" = "transaction";
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
                if (request.stage !== stage) {
                  throw new Error("Worker environment write admission is out of order");
                }
                check();
                if (request.stage === "commit") {
                  const facts = isRecord(request.facts)
                    ? request.facts.environments
                    : request.facts;
                  if (!isWorkerEnvironmentCommitAdmission(facts)) {
                    throw new Error("Worker inventory commit lacks affected authority facts");
                  }
                  committedIds = facts.map((fact) => fact.environmentId);
                  owner.fence(facts, token);
                  if (isRecord(request.facts)) {
                    if (
                      type !== "workerEnvironments.acceptRetainedRecovery" ||
                      !isRecoveryPublication(request.facts.recovery)
                    ) {
                      throw new Error("Worker recovery commit lacks current postimages");
                    }
                    recovery = request.facts.recovery;
                    workspacePublication = stageRepositoryWorkspacePublication(
                      context.admission,
                      recovery.workspace,
                    );
                    placementPublication = stagePlacementTurnClaimWorkerPublication(
                      context.admission.identity,
                      recovery.placement,
                      { placement: recovery.placement, pendingResult: undefined },
                    );
                  }
                }
                if (!grant()) {
                  throw new Error("Worker environment mutation admission expired");
                }
                if (request.stage === "commit") {
                  commitSequence = owner.nextSequence();
                }
                stage = "commit";
              });
              return { nativeLocations: [pathname], admission };
            },
          },
        );
      } catch (error) {
        const nativeCommit = admission?.committed;
        const settlement = admission?.settlement;
        const committedReceipt = nativeCommit ?? settlement?.committed;
        const committed = committedReceipt?.facts;
        if (
          isRecord(committed) &&
          isInventoryFacts(committed.facts) &&
          commitSequence !== undefined
        ) {
          settleRecovery(
            true,
            true,
            isRecoveryPublication(committed.recovery) ? committed.recovery : undefined,
          );
          owner.install(committed.facts, commitSequence, false);
          owner.release(token);
          publishRevocation();
          if (committed.changed === true) {
            sessionChanges.emit({ all: true, scope: "worker-environments" });
          }
        } else if (
          commitSequence !== undefined &&
          !(settlement?.kind === "completed" && !committedReceipt)
        ) {
          // Retain only facts about settled writes, so another live facade can retry the read.
          owner.retainReconciliation(
            token,
            committedIds,
            error,
            revocationPublished ? undefined : revocationId,
          );
          await reconcilePending();
        }
        owner.release(token);
        throw error;
      } finally {
        if (!recoverySettled) {
          const settlement = admission?.settlement;
          settleRecovery(
            false,
            commitSequence === undefined ||
              (settlement?.kind === "completed" && !settlement.committed),
          );
        }
        if (commitSequence === undefined) {
          owner.release(token);
        }
      }
    });
    return track(operation);
  }
  const close = () =>
    (closing ??= (async () => {
      await Promise.allSettled(operations);
      closed = true;
      for (const unsubscribe of revocationSubscriptions) {
        unsubscribe();
      }
      revocationSubscriptions.clear();
      unregister();
      if (releaseOwner()) {
        workerEnvironmentProjections.remove(owner);
      }
    })());
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    close: async (identity) => {
      if (!identity || identity.key === context.admission.identity.key) {
        await close();
      }
    },
  });
  try {
    await mutate("workerEnvironments.initialize", {});
    // First creation publishes its physical identity through the captured admission.
    workerEnvironmentProjections.get(context.admission.identity);
    // Hydration joins writer publication; native commits invalidate an in-flight snapshot.
    await owner.enqueue(async () => {
      for (;;) {
        const version = owner.version();
        const facts = await snapshot();
        if (owner.version() !== version) {
          continue;
        }
        owner.install(facts, owner.nextSequence(), false);
        break;
      }
    });
  } catch (error) {
    await close();
    throw error;
  }
  let reservationVersion = -1;
  let reservations: ReturnType<typeof selectPreparedEnvironmentReservations> = [];
  const prepared = () => {
    if (reservationVersion !== owner.version()) {
      reservations = selectPreparedEnvironmentReservations(owner.preparedRecords());
      reservationVersion = owner.version();
    }
    return reservations;
  };
  const ready = async () => {
    assertActive();
    for (;;) {
      await owner.ready();
      assertActive();
      if (!owner.hasPendingReconciliation()) {
        return;
      }
      await track(owner.enqueue(reconcilePending));
    }
  };
  const store = {
    retainPreparedEnvironment({ assertCurrent, ...input }: Input<"retainPreparedEnvironment">) {
      return mutate(
        "workerEnvironments.retainPreparedEnvironment",
        { input },
        assertCurrent,
        input.environmentId,
      );
    },
    retainFailedEnvironment({ assertCurrent, ...input }: Input<"retainFailedEnvironment">) {
      return mutate(
        "workerEnvironments.retainFailedEnvironment",
        { input },
        assertCurrent,
        input.environmentId,
      );
    },
    acceptRetainedRecovery({ assertCurrent, ...input }: Input<"acceptRetainedRecovery">) {
      return mutate("workerEnvironments.acceptRetainedRecovery", { input }, assertCurrent);
    },
    close,
    ready,
    async hasSessionAttachment(environmentId: string): Promise<boolean> {
      await ready();
      return read(() =>
        owner.hasSessionAttachment(requireWorkerEnvironmentString(environmentId, "id")),
      );
    },
    inventoryVersion: () => read(owner.version),
    get: (id: string) => read(() => owner.get(requireWorkerEnvironmentString(id, "id"))),
    list: () => read(() => owner.list()),
    listForReconcile: () => read(() => owner.list(true)),
    getCredential: (id: string) =>
      read(() => owner.credential(requireWorkerEnvironmentString(id, "id"))),
    findCredentialByHash: (hash: string) =>
      read(() => owner.credentialByHash(normalizeCredentialHash(hash))),
    getTransferOwner: (id: string) =>
      read(() => owner.transferOwner(requireWorkerEnvironmentString(id, "id"))),
    hasNodeEnrollmentOwner: (nodeId: string) => read(() => owner.hasNodeEnrollmentOwner(nodeId)),
    hasPendingNodeEnrollmentSetup: (setup: string, device: string) =>
      read(() => owner.hasPendingNodeEnrollmentSetup(setup, device)),
    preparedCapacity: (input: Parameters<typeof preparedCapacityFromReservations>[1]) =>
      read(() => preparedCapacityFromReservations(prepared(), input)),
    preparedReservationEnvironmentIds: () =>
      read(() => prepared().map((record) => record.environmentId)),
    isPreparedIntentWithinCapacity: (
      input: Parameters<typeof isPreparedReservationWithinCapacity>[1],
    ) =>
      read(() => {
        owner.get(input.environmentId);
        return isPreparedReservationWithinCapacity(prepared(), input);
      }),
    getSessionAttachmentRecord: (id: string) => read(() => owner.attachment(id)),
    listSessionAttachmentRecords: () => read(() => owner.attachments()),
    findSessionAttachmentRecord(
      input: Pick<WorkerEnvironmentSessionIdentity, "agentId" | "sessionKey">,
    ) {
      assertActive();
      const rows = owner
        .attachments()
        .filter(
          (row) =>
            row.agentId === input.agentId &&
            row.sessionKey === input.sessionKey &&
            row.closedAtMs === null,
        );
      return rows.length === 1 ? owner.attachment(rows[0]!.sessionId) : undefined;
    },
    onCredentialRevoked(listener: (id: string) => void) {
      assertActive();
      const unsubscribe = owner.onCredentialRevoked(listener);
      revocationSubscriptions.add(unsubscribe);
      return () => {
        unsubscribe();
        revocationSubscriptions.delete(unsubscribe);
      };
    },
    createIntent: (input: Input<"createIntent">, assertCurrent?: () => void) =>
      mutate("workerEnvironments.createIntent", { input }, assertCurrent),
    ensureNodeEnrollment: (input: string) =>
      mutate("workerEnvironments.ensureNodeEnrollment", { input }),
    async revokeEnvironmentCredential(
      input: string,
      opts: {
        fenceWorkspaceTransfers?: boolean;
        expectedOwnerEpoch?: number;
        assertCurrent?: () => void;
      } = {},
    ) {
      const environmentId = requireWorkerEnvironmentString(input, "id");
      await mutate(
        "workerEnvironments.revokeEnvironmentCredential",
        {
          input: { environmentId, expectedOwnerEpoch: opts.expectedOwnerEpoch },
        },
        opts.assertCurrent,
        opts.fenceWorkspaceTransfers ? environmentId : undefined,
      );
    },
    reconcileSharedHost: (input: Input<"reconcileSharedHost">) =>
      mutate("workerEnvironments.reconcileSharedHost", { input }),
    adoptProvisionCleanupFailure({
      assertCurrent,
      ...input
    }: Input<"adoptProvisionCleanupFailure">) {
      return mutate("workerEnvironments.adoptProvisionCleanupFailure", { input }, assertCurrent);
    },
    requestDestroy({ assertCurrent, ...input }: Input<"requestDestroy">) {
      return mutate("workerEnvironments.requestDestroy", { input }, assertCurrent);
    },
    refreshBootstrapReceipt({ assertCurrent, ...input }: Input<"refreshBootstrapReceipt">) {
      return mutate("workerEnvironments.refreshBootstrapReceipt", { input }, assertCurrent);
    },
    transition({ assertCurrent, placementBinding, ...input }: Input<"transition">) {
      const binding = placementBinding
        ? (({ assertCurrent: _guard, ...facts }) => facts)(placementBinding)
        : undefined;
      return mutate(
        "workerEnvironments.transition",
        { input: { ...input, placementBinding: binding } },
        () => {
          assertCurrent?.();
          placementBinding?.assertCurrent();
        },
      );
    },
    renewCredential({ assertCurrent, ...input }: Input<"renewCredential">) {
      return mutate("workerEnvironments.renewCredential", { input }, assertCurrent);
    },
    markCredentialDelivered({ assertCurrent, ...input }: Input<"markCredentialDelivered">) {
      return mutate("workerEnvironments.markCredentialDelivered", { input }, assertCurrent);
    },
    recordError({ assertCurrent, ...input }: Input<"recordError">) {
      return mutate("workerEnvironments.recordError", { input }, assertCurrent);
    },
    ensurePreparedIntent({ assertCurrent, ...input }: Input<"ensurePreparedIntent">) {
      return mutate("workerEnvironments.ensurePreparedIntent", { input }, assertCurrent);
    },
    requestPreparedDestroy({ assertCurrent, ...input }: Input<"requestPreparedDestroy">) {
      return mutate("workerEnvironments.requestPreparedDestroy", { input }, assertCurrent);
    },
    createSessionAttachmentIntent(
      input: Input<"createSessionAttachmentIntent">,
      assertCurrent: () => void,
    ) {
      return mutate("workerEnvironments.createSessionAttachmentIntent", { input }, assertCurrent);
    },
    closeSessionAttachment(input: string, assertCurrent: () => void = () => {}) {
      return mutate("workerEnvironments.closeSessionAttachment", { input }, assertCurrent);
    },
    cancelSessionAttachmentReservation(input: Input<"cancelSessionAttachmentReservation">) {
      return mutate("workerEnvironments.cancelSessionAttachmentReservation", { input });
    },
    touchSessionAttachment(input: Input<"touchSessionAttachment">, assertCurrent: () => void) {
      return mutate("workerEnvironments.touchSessionAttachment", { input }, assertCurrent);
    },
    async pruneTerminalEnvironments(input: WorkerEnvironmentPruneInput = {}) {
      assertActive();
      const nowMs = input.nowMs ?? now();
      const canPruneDemand = input.canPruneDemand;
      const approved: WorkerEnvironmentPrunePage["candidates"] = [];
      let cursor: WorkerEnvironmentPruneCursor | undefined;
      for (;;) {
        const reply = await executeExistingOpenClawStateRead(
          { path: pathname },
          {
            type: "workerEnvironments.pruneCandidates",
            input: { nowMs, limit: input.limit, cursor },
          },
        );
        assertActive();
        if (!reply || !reply.ok || reply.type !== "workerEnvironments.pruneCandidates") {
          throw new Error("Worker environment retention candidates could not be read");
        }
        const page = reply.page;
        for (const candidate of page.candidates) {
          if (canPruneDemand?.(candidate.record, nowMs) ?? true) {
            approved.push(candidate);
          }
          if (approved.length === page.limit) {
            break;
          }
        }
        if (approved.length === page.limit || !page.nextCursor) {
          break;
        }
        cursor = page.nextCursor;
      }
      if (!approved.length) {
        return 0;
      }
      const demandChanged = new Error("Worker environment demand changed during retention");
      try {
        return await mutate(
          "workerEnvironments.pruneTerminalEnvironments",
          {
            input: { approved: approved.map((candidate) => candidate.observed) },
          },
          () => {
            for (const candidate of approved) {
              if (!(canPruneDemand?.(candidate.record, nowMs) ?? true)) {
                throw demandChanged;
              }
            }
          },
        );
      } catch (error) {
        if (error === demandChanged) {
          return 0;
        }
        throw error;
      }
    },
  };
  return store;
}
export type WorkerEnvironmentStore = Awaited<ReturnType<typeof createWorkerEnvironmentStore>>;
