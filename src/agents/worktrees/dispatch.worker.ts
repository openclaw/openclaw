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
import {
  deleteTemplate,
  hasTemplates,
  listTemplates,
  markTemplateReady,
  readTemplate,
  reserveTemplate,
  touchTemplate,
} from "./template-registry.js";
import { worktreeTemplateMutation } from "./template-registry.worker.js";
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
  "worktrees.templates.read": ({ cacheKey }: { cacheKey: string }, { stateOptions }) =>
    readTemplate(stateOptions().env, cacheKey),
  "worktrees.templates.has": (_input: undefined, { stateOptions }) =>
    hasTemplates(stateOptions().env),
  "worktrees.templates.list": (_input: undefined, { stateOptions }) =>
    listTemplates(stateOptions().env),
  "worktrees.templates.reserve": worktreeTemplateMutation(
    "worktrees.templates.reserve",
    reserveTemplate,
  ),
  "worktrees.templates.ready": worktreeTemplateMutation(
    "worktrees.templates.ready",
    (env, { id, now }: { id: string; now: number }, commitGuard) =>
      markTemplateReady(env, id, now, commitGuard),
  ),
  "worktrees.templates.touch": worktreeTemplateMutation(
    "worktrees.templates.touch",
    (env, { id, now }: { id: string; now: number }, commitGuard) =>
      touchTemplate(env, id, now, commitGuard),
  ),
  "worktrees.templates.delete": worktreeTemplateMutation(
    "worktrees.templates.delete",
    (env, { id }: { id: string }, commitGuard) => deleteTemplate(env, id, commitGuard),
  ),
} satisfies WorkerOperationHandlers;

export type WorktreeWorkerOperations = WorkerOperations<typeof worktreeOperations>;
