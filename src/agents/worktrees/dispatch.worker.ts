import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  reservePendingWorktreeInDatabase,
  releasePendingWorktreeInDatabase,
} from "./pending-slots.worker.js";
import { writeProvisionedSnapshotInDatabase } from "./provisioned-snapshot.worker.js";
import { withWorktreeRegistryWorkerReceipt } from "./registry-publication.js";
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
import type { WorktreeRegistryPredicate } from "./types.js";

export const worktreeOperations = {
  "worktrees.assertPredicates": (
    { predicates }: { predicates: readonly WorktreeRegistryPredicate[] },
    { open },
  ) => assertWorktreeRegistryPredicates(open().db, predicates),
  "worktrees.delete": worktreeRunEndMutation("worktrees.delete", deleteRegistryWorktreeInDatabase),
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
