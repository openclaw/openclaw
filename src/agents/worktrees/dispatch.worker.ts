import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  readPendingWorktreesInDatabase,
  reservePendingWorktreeInDatabase,
  releasePendingWorktreeInDatabase,
  readWorktreeSlotCountInDatabase,
} from "./pending-slots.worker.js";
import { writeProvisionedSnapshotInDatabase } from "./provisioned-snapshot.worker.js";
import { withWorktreeRegistryWorkerReceipt } from "./registry-publication.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  findLiveRegistryWorktreeByPathInDatabase,
  getRegistryWorktreeInDatabase,
  getRegistryWorktreeProvisionedChunkInDatabase,
  getRegistryWorktreeProvisionedPathsInDatabase,
  getRegistryWorktreeProvisionedStateInDatabase,
  listLiveRegistryWorktreeIdsInDatabase,
  listRegistryWorktreesInDatabase,
  type WorktreeRegistryListOptions,
} from "./registry-read.kernel.js";
import {
  retireMissingWorktreeInWorker,
  deferWorktreeCleanupInWorker,
} from "./registry-retirement.worker.js";
import {
  worktreeRunEndMutation,
  claimWorktreeRemovalInDatabase,
  finalizeWorktreeRemovalInDatabase,
  abortWorktreeRemovalInDatabase,
  insertRegistryWorktreeInDatabase,
  updateRegistryWorktreeInDatabase,
  deleteRegistryWorktreeInDatabase,
  assertWorktreeRegistryPredicates,
} from "./registry-run-end.worker.js";
import { reapWorktreeRunLeasesInDatabase } from "./run-lease-owner.js";
import {
  admitWorktreeRunLeaseInDatabase,
  releaseWorktreeRunLeaseInDatabase,
  type WorktreeRunLeaseRowInput,
} from "./run-lease-store.kernel.js";
import type { ManagedWorktreeOwnerKind, WorktreeRegistryPredicate } from "./types.js";

export const worktreeOperations = {
  "worktrees.assertPredicates": (
    { predicates }: { predicates: readonly WorktreeRegistryPredicate[] },
    { open },
  ) => assertWorktreeRegistryPredicates(open().db, predicates),
  "worktrees.delete": worktreeRunEndMutation("worktrees.delete", deleteRegistryWorktreeInDatabase),
  "worktrees.slotCount": (_input: undefined, { open }) =>
    readWorktreeSlotCountInDatabase(open().db),
  "worktrees.pendingSlots": (_input: undefined, { open }) =>
    readPendingWorktreesInDatabase(open().db),
  "worktrees.reservePending": worktreeRunEndMutation(
    "worktrees.reservePending",
    reservePendingWorktreeInDatabase,
  ),
  "worktrees.releasePending": worktreeRunEndMutation(
    "worktrees.releasePending",
    releasePendingWorktreeInDatabase,
  ),
  "worktrees.insert": worktreeRunEndMutation("worktrees.insert", insertRegistryWorktreeInDatabase),
  "worktrees.update": worktreeRunEndMutation("worktrees.update", updateRegistryWorktreeInDatabase),
  "worktrees.claimRemoval": worktreeRunEndMutation(
    "worktrees.claimRemoval",
    claimWorktreeRemovalInDatabase,
  ),
  "worktrees.finalizeRemoval": worktreeRunEndMutation(
    "worktrees.finalizeRemoval",
    finalizeWorktreeRemovalInDatabase,
  ),
  "worktrees.abortRemoval": worktreeRunEndMutation(
    "worktrees.abortRemoval",
    abortWorktreeRemovalInDatabase,
  ),
  "worktrees.findLiveByOwner": (
    { ownerKind, ownerId }: { ownerKind: ManagedWorktreeOwnerKind; ownerId: string },
    { open },
  ) => findLiveRegistryWorktreeByOwnerInDatabase(open().db, ownerKind, ownerId),
  "worktrees.get": ({ id }: { id: string }, { open }) =>
    getRegistryWorktreeInDatabase(open().db, id),
  "worktrees.sessionBinding": (
    { boundId, ownerId }: { boundId?: string; ownerId: string },
    { open },
  ) => {
    const { db } = open();
    const bound = boundId ? getRegistryWorktreeInDatabase(db, boundId) : undefined;
    if (bound && bound.removedAt === undefined) {
      return bound;
    }
    return findLiveRegistryWorktreeByOwnerInDatabase(db, "session", ownerId);
  },
  "worktrees.findLiveByPath": ({ path }: { path: string }, { open }) =>
    findLiveRegistryWorktreeByPathInDatabase(open().db, path),
  "worktrees.list": (input: WorktreeRegistryListOptions, { open }) =>
    listRegistryWorktreesInDatabase(open().db, input),
  "worktrees.liveIds": (_input: undefined, { open }) =>
    listLiveRegistryWorktreeIdsInDatabase(open().db),
  "worktrees.provisionedPaths": ({ id }: { id: string }, { open }) =>
    getRegistryWorktreeProvisionedPathsInDatabase(open().db, id),
  "worktrees.provisionedState": ({ id }: { id: string }, { open }) =>
    getRegistryWorktreeProvisionedStateInDatabase(open().db, id),
  "worktrees.provisionedChunk": (
    input: Parameters<typeof getRegistryWorktreeProvisionedChunkInDatabase>[1],
    { open },
  ) => getRegistryWorktreeProvisionedChunkInDatabase(open().db, input),
  "worktrees.writeProvisionedSnapshot": worktreeRunEndMutation(
    "worktrees.writeProvisionedSnapshot",
    writeProvisionedSnapshotInDatabase,
  ),
  "worktrees.retireMissing": (
    input: Parameters<typeof retireMissingWorktreeInWorker>[0],
    { open, stateOptions },
  ) => retireMissingWorktreeInWorker(input, { ...stateOptions(), database: open() }),
  "worktrees.deferCleanup": (
    input: Parameters<typeof deferWorktreeCleanupInWorker>[0],
    { open, stateOptions },
  ) => deferWorktreeCleanupInWorker(input, { ...stateOptions(), database: open() }),
  "worktrees.admitRunLease": (input: WorktreeRunLeaseRowInput, { writeAdmitted }) =>
    writeAdmitted(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () => admitWorktreeRunLeaseInDatabase(db, input)),
      {
        operationLabel: "worktrees.admitRunLease",
      },
    ),
  "worktrees.releaseRunLease": (
    { worktreeId, token }: { worktreeId: string; token: string },
    { writeAdmitted },
  ) =>
    writeAdmitted(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () =>
          releaseWorktreeRunLeaseInDatabase(db, worktreeId, token),
        ),
      {
        operationLabel: "worktrees.releaseRunLease",
      },
    ),
  "worktrees.reapRunLeases": ({ scopes }: { scopes: string[] }, { writeAdmitted }) =>
    writeAdmitted(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () => reapWorktreeRunLeasesInDatabase(db, scopes)),
      {
        operationLabel: "worktrees.reapRunLeases",
      },
    ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type WorktreeWorkerOperations = WorkerOperations<typeof worktreeOperations>;
