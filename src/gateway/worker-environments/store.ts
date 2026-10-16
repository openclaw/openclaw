import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { publishSqliteCommittedState } from "../../infra/sqlite-post-commit.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
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
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";
import {
  isPreparedReservationWithinCapacity,
  preparedCapacityFromReservations,
  selectPreparedEnvironmentReservations,
} from "./prepared-environment-store.js";
import type { WorkerEnvironmentSessionIdentity } from "./session-attachment.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { workerEnvironmentProjections } from "./store-projection.js";
import { readWorkerEnvironmentReceipt } from "./store-receipt.js";
import { normalizeCredentialHash, requireWorkerEnvironmentString } from "./store-validation.js";
import type { WorkerEnvironmentWorkerOperations } from "./store-worker-contract.js";
import type { WorkerEnvironmentPruneInput } from "./store-write-types.js";
import type {
  WorkerEnvironmentCommitAdmission,
  WorkerEnvironmentMutationMethods,
  WorkerEnvironmentPruneCursor,
  WorkerEnvironmentPrunePage,
} from "./store.types.js";

export type {
  PreparedEnvironmentPlacementBinding,
  WorkerEnvironmentRecord,
} from "./environment-record.js";
export type { WorkerEnvironmentTransitionPatch } from "./store-write-types.js";

type Input<Method extends keyof WorkerEnvironmentMutationMethods> = Parameters<
  WorkerEnvironmentMutationMethods[Method]
>[0];
type Operations = WorkerEnvironmentWorkerOperations;

function isCommitAdmission(value: unknown): value is WorkerEnvironmentCommitAdmission {
  return (
    Array.isArray(value) &&
    value.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.environmentId === "string" &&
        typeof fact.environmentAuthority === "string" &&
        typeof fact.credentialAuthority === "string" &&
        typeof fact.transferAuthority === "string" &&
        typeof fact.attachmentAuthority === "string",
    )
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
      throw new WorkerEnvironmentInventoryClosedError();
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
  function mutate<Key extends keyof Operations>(
    type: Key,
    input: Omit<Operations[Key]["input"], "publicationIncarnation">,
    assertCurrent: () => void = () => {},
    revocationId?: string,
  ): Promise<Operations[Key]["output"]["result"]> {
    assertActive();
    if (closing) {
      throw new Error("Worker environment inventory is closing");
    }
    const captured = structuredClone({
      ...input,
      nowMs: options.now?.(),
      publicationIncarnation: owner.incarnation,
    });
    const operation = owner.enqueue(async () => {
      const token = {};
      let admission: SqliteWorkerOperationAdmission | undefined;
      let commitSequence: number | undefined;
      let committedIds: readonly string[] = [];
      let revocationPublished = false;
      let installed = false;
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
      const install = (receipt: unknown) => {
        if (installed) {
          return;
        }
        if (!isRecord(receipt) || commitSequence === undefined) {
          throw new Error("Worker environment mutation has no commit admission");
        }
        context.admission.assertCurrent();
        const facts = readWorkerEnvironmentReceipt(
          receipt.publication,
          { identity: context.admission.identity.key, incarnation: owner.incarnation },
          committedIds,
        );
        const revision = commitSequence;
        publishSqliteCommittedState({
          installFacts() {
            owner.install(facts, revision, false);
            for (const placement of facts.placements ?? []) {
              stagePlacementTurnClaimWorkerPublication(
                context.admission.identity,
                placement,
                undefined,
                undefined,
                placement,
              ).commit();
            }
            owner.release(token);
            installed = true;
          },
          invalidate() {
            owner.close();
            installed = true;
          },
          installProjection: publishRevocation,
          notify() {
            if (receipt.changed === true) {
              sessionChanges.emit({ all: true, scope: "worker-environments" });
            }
          },
        });
      };
      check();
      try {
        return await runOpenClawStateWorkerOperation(
          context,
          async (scope) => {
            const receipt = await scope.execute({ type, input: captured });
            install(receipt);
            return receipt.result;
          },
          {
            assertCurrent: check,
            createAdmission: () => {
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
                check();
                if (request.stage === "commit") {
                  if (!isCommitAdmission(request.facts)) {
                    throw new Error("Worker inventory commit lacks affected authority facts");
                  }
                  committedIds = request.facts.map((fact) => fact.environmentId);
                  owner.fence(request.facts, token);
                }
                if (!grant()) {
                  throw new Error("Worker environment mutation admission expired");
                }
                if (request.stage === "commit") {
                  commitSequence = owner.nextSequence();
                }
              });
              observeSqliteWorkerCommittedFacts(admission, ({ facts }) => install(facts));
              return { nativeLocations: [pathname], admission };
            },
          },
        );
      } catch (error) {
        const nativeCommit = admission?.committed;
        const settlement = admission?.settlement;
        const committedReceipt = nativeCommit ?? settlement?.committed;
        const committed = committedReceipt?.facts;
        if (!installed && committed) {
          try {
            install(committed);
          } catch {
            // Malformed coverage cannot turn omitted keys into deletion facts.
          }
        }
        if (
          !installed &&
          commitSequence !== undefined &&
          !(settlement?.kind === "completed" && !committedReceipt)
        ) {
          try {
            const revision = owner.nextSequence();
            const facts = await snapshot(committedIds);
            publishSqliteCommittedState({
              installFacts() {
                owner.install(facts, revision, false);
                owner.release(token);
              },
              installProjection() {
                if (
                  revocationId &&
                  !facts.credentials.some((credential) => credential.environmentId === revocationId)
                ) {
                  publishRevocation();
                }
              },
              invalidate: () => owner.close(),
              notify: () => sessionChanges.emit({ all: true, scope: "worker-environments" }),
            });
          } catch {
            // SQLite retains the write; a new inventory reloads after this readback fails.
            owner.close();
          }
        }
        owner.release(token);
        throw error;
      } finally {
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
    // Hydration joins the inventory writer queue.
    await owner.enqueue(async () => {
      const facts = await snapshot();
      owner.install(facts, owner.nextSequence(), false);
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
    await owner.ready();
    assertActive();
  };
  const store = {
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
    adoptProvisionCleanupFailure: (input: Input<"adoptProvisionCleanupFailure">) =>
      mutate("workerEnvironments.adoptProvisionCleanupFailure", { input }),
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
