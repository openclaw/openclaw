import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../../state/worker-operation-registry.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
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
import { reapWorktreeRunLeasesInDatabase } from "./run-lease-owner.js";
import {
  admitWorktreeRunLeaseInDatabase,
  releaseWorktreeRunLeaseInDatabase,
} from "./run-lease-store.kernel.js";
import { worktreeRunLeaseOperation } from "./run-lease-store.worker.js";
import type { ManagedWorktreeOwnerKind } from "./types.js";

export const worktreeOperations = {
  "worktrees.findLiveByOwner": (
    { ownerKind, ownerId }: { ownerKind: ManagedWorktreeOwnerKind; ownerId: string },
    { open },
  ) => findLiveRegistryWorktreeByOwnerInDatabase(open().db, ownerKind, ownerId),
  "worktrees.get": ({ id }: { id: string }, { open }) =>
    getRegistryWorktreeInDatabase(open().db, id),
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
  "worktrees.retireMissing": (
    input: Parameters<typeof retireMissingWorktreeInWorker>[0],
    { open, stateOptions },
  ) => retireMissingWorktreeInWorker(input, { ...stateOptions(), database: open() }),
  "worktrees.deferCleanup": (
    input: Parameters<typeof deferWorktreeCleanupInWorker>[0],
    { open, stateOptions },
  ) => deferWorktreeCleanupInWorker(input, { ...stateOptions(), database: open() }),
  "worktrees.admitRunLease": worktreeRunLeaseOperation(
    "worktrees.admitRunLease",
    admitWorktreeRunLeaseInDatabase,
  ),
  "worktrees.releaseRunLease": worktreeRunLeaseOperation(
    "worktrees.releaseRunLease",
    (db, { worktreeId, token }: { worktreeId: string; token: string }) =>
      releaseWorktreeRunLeaseInDatabase(db, worktreeId, token),
  ),
  "worktrees.reapRunLeases": worktreeRunLeaseOperation(
    "worktrees.reapRunLeases",
    (db, { scopes }: { scopes: string[] }) => reapWorktreeRunLeasesInDatabase(db, scopes),
  ),
} satisfies WorkerOperationHandlers;

export type WorktreeWorkerOperations = WorkerOperations<typeof worktreeOperations>;
