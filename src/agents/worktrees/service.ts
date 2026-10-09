import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { startGitOperationTiming } from "../../infra/git-operation-timing.js";
import { runGitReadOperation } from "../../infra/git-read-cache.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { acquireManagedWorktree } from "./activity.js";
import {
  withWorktreeAllocationLease,
  withWorktreeMutationLease,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import { logWorktreeBase, resolveWorktreeBase } from "./base-ref.js";
import { createWorktreeCapacityOwner } from "./capacity-owner.js";
import {
  directorySizeBytes,
  estimateWorktreeGitBytes,
  requireAllocationSpace,
  retryWorktreeCapacityReleases,
  WORKTREE_SETUP_HEADROOM_BYTES,
} from "./capacity.js";
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import { addManagedWorktree } from "./checkout.js";
import { ensureEmptyWorktreeSource, removeUnusedEmptyWorktreeSource } from "./empty-source.js";
import { hasWorktreeUnknownOutcome, WorktreePendingContentionError } from "./errors.js";
import { collectRetiredWorktreeArtifacts } from "./gc-artifacts.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { autoRemovalProtectionReason, type WorktreeCleanupDeferrals } from "./gc-protection.js";
import {
  createWorktreeGcRemoval,
  removeWorktreeIfLossless,
  type WorktreeCleanupOwnerPolicy,
} from "./gc-removal.js";
import { createWorktreeGcPrefilter, lockState, unlockWorktree } from "./git-lock.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { commandError, worktreePathExists, runGit } from "./git.js";
import { validateName } from "./name.js";
import { worktreeOwnerMatches } from "./owner.js";
import { readPendingWorktrees, reservePendingWorktree } from "./pending-slots.js";
import {
  timeWorktreePreparationPhase,
  withWorktreePreparationTiming,
} from "./preparation-timing.js";
import { provisionIncludedFiles } from "./provisioned-files.js";
import {
  readRegistryWorktrees,
  readRegistryWorktreeForMutation,
  requireActiveWorktreeRecord,
  readWorktreeCleanupState,
  readLiveRegistryWorktreeByPath,
  readLiveRegistryWorktreeByOwner,
} from "./registry-read.js";
import { deferFailedWorktreeRemoval, isWorktreeRemovalTimeout } from "./registry-retirement.js";
import {
  assertWorktreeRemovalAvailable,
  insertRegistryWorktree,
  createWorktreeRemovalClaimsGuard,
  updateRegistryWorktree,
} from "./registry.js";
import { assertExactStateOwner } from "./removal-git.js";
import { removeSettledManagedWorktree, type RemoveWorktreeParams } from "./removal.js";
import { captureWorktreeRunEndContext, withWorktreeRunEnd } from "./run-end-lifecycle.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import { reapWorktreeRunLeases } from "./run-lease-store.js";
import {
  abortWorktreeRemoval,
  claimWorktreeRemoval,
  hasLiveWorktreeRunLease,
} from "./run-lease.js";
import { reconcileListedWorktrees } from "./service-list.js";
import {
  removeFailedWorktree,
  createWithWorktreeAllocation,
  createOwnedWorktree,
  prepareWorktreeDestination,
  findWorktreeByName,
  resolveRepository,
  rebindLiveWorktreeRepository,
  resolveRepositoryIdentity,
  runSetupScript,
  withWorktreeSource,
  withWorktreeSources,
  type ResolvedRepository,
  type WorktreeSourceCustody,
} from "./service-preparation.js";
import {
  exactStateRetirementSchema,
  type ExactStateRetirement,
} from "./snapshot-exact-state-contract.js";
import { retireManagedWorktreeSnapshotById } from "./snapshot-host.js";
import {
  restoreManagedWorktreeSnapshot,
  requireManagedWorktreeRestoreRecord,
} from "./snapshot-restore.js";
import { collectWorktreeTemplates } from "./template-cache.js";
import { hasTemplatesAsync } from "./template-registry-async.js";
import type {
  CreateEmptyManagedWorktreeParams,
  CreateManagedWorktreeParams,
  ManagedWorktreeBranchesResult,
  ManagedWorktreeCreationOutcome,
  ManagedWorktreeGcResult,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
  RetireManagedWorktreeSnapshotParams,
  WorktreeMutationGuard,
  WorktreeCreationPublication,
  WorktreeRemovalDeferral,
} from "./types.js";

export {
  WorktreeSnapshotError,
  WorktreeRemovalLockError,
  classifyWorktreeRemovalError,
  type WorktreeRemovalFailureReason,
} from "./removal-errors.js";

export const IDLE_GC_MS = 7 * 24 * 60 * 60 * 1000; // Idle worktrees remain restorable after automatic cleanup.
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // Snapshot refs expire with their registry affordance.
export const WORKTREE_GC_INTERVAL_MS = 60 * 60 * 1000;

export { WorktreeRepositoryError } from "./errors.js";
const log = createSubsystemLogger("agents/worktrees");

type ServiceOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  getConfig?: () => OpenClawConfig;
};

type ManagedWorktreeGcParams = WorktreeCleanupOwnerPolicy &
  WorktreeMutationGuard & {
    checkpoint?: (progress: ManagedWorktreeGcResult) => Promise<void>;
  };

type WorktreeCreation =
  | ManagedWorktreeCreationOutcome
  | (() => Promise<ManagedWorktreeCreationOutcome>);
type MaterializedRepositoryWorktree = {
  worktreePath: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};

async function claimManagedRemoval(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  params: RemoveWorktreeParams,
): Promise<string> {
  const token = params.claimToken ?? randomUUID();
  const claim = () =>
    claimWorktreeRemoval(env, {
      worktreeId: record.id,
      token,
      assertCurrent: params.commitGuard,
      workerAuthority: {
        ...params.workerAuthority,
        assertCurrent: params.workerAuthority
          ? params.workerAuthority.assertCurrent
          : params.commitGuard,
        predicates: [...(params.workerAuthority?.predicates ?? []), { kind: "binding", record }],
      },
    });
  await (params.withOwnerMutation ? params.withOwnerMutation(claim) : claim());
  return token;
}

export class ManagedWorktreeService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly getConfig: ServiceOptions["getConfig"];
  private readonly capacity: ReturnType<typeof createWorktreeCapacityOwner>;
  private readonly cleanupDeferrals: WorktreeCleanupDeferrals = new Map();
  private readonly maintainGit: ReturnType<typeof createWorktreeGitMaintenance>;

  constructor(options: ServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.getConfig = options.getConfig;
    this.maintainGit = createWorktreeGitMaintenance(this.env);
    this.capacity = createWorktreeCapacityOwner({
      env: this.env,
      now: this.now,
      getConfig: this.getConfig,
    });
  }

  async create(params: CreateManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    return (await this.createWithOutcome(params)).record;
  }

  async createWithOutcome(
    params: CreateManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    return withWorktreePreparationTiming("managed", () =>
      withWorktreeRunEnd(this.env, async () => {
        params.signal?.throwIfAborted();
        const repository = await resolveRepository(params.repoRoot);
        return await createWithWorktreeAllocation(
          { ...params, env: this.env },
          async (guard, publication) =>
            await withWorktreeSources(this.env, async (retainRepository) => {
              const retainSources = await retainRepository({ ...params, ...guard, repository });
              const owned = { ...params, ...guard, retainSources };
              const creation = await this.withAllocationLease(owned, (allocation) =>
                this.reserveForOwner(owned, allocation, repository, publication),
              );
              return typeof creation === "function" ? await creation() : creation;
            }),
          (record) => this.rollbackPreparation(record, params.withRollback),
        );
      }),
    );
  }

  async createEmpty(params: CreateEmptyManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    return (await this.createEmptyWithOutcome(params)).record;
  }

  async createEmptyWithOutcome(
    params: CreateEmptyManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    return withWorktreePreparationTiming("managed", () =>
      withWorktreeRunEnd(this.env, async () => {
        let sourceRoot: string | undefined;
        try {
          return await createWithWorktreeAllocation(
            { ...params, env: this.env },
            async (guard, publication) =>
              withWorktreeSources(this.env, async (retainRepository) => {
                const creation = await this.withAllocationLease(
                  { ...params, ...guard },
                  async (allocation) => {
                    const repoRoot = await ensureEmptyWorktreeSource({
                      env: this.env,
                      ownerId: params.ownerId,
                      signal: allocation.signal,
                      commitGuard: allocation.commitGuard,
                    });
                    sourceRoot = repoRoot;
                    const repository = await resolveRepository(repoRoot);
                    const prepared = {
                      ...params,
                      ...guard,
                      repoRoot,
                      baseRef: "main",
                      runSetupScript: false,
                    };
                    const retainSources = await retainRepository({ ...prepared, repository });
                    return await this.reserveForOwner(
                      { ...prepared, retainSources },
                      allocation,
                      repository,
                      publication,
                    );
                  },
                );
                return typeof creation === "function" ? await creation() : creation;
              }),
            (record) => this.rollbackPreparation(record, params.withRollback),
          );
        } catch (error) {
          if (sourceRoot) {
            const repoRoot = sourceRoot;
            try {
              // Cancellation retires caller authority. Reacquire allocation ownership
              // before cleaning a source that never received a registry record.
              await this.withAllocationLease({}, async (guard) => {
                await removeUnusedEmptyWorktreeSource({
                  env: this.env,
                  record: { repoRoot, ownerKind: "session", ownerId: params.ownerId },
                  signal: guard.signal,
                  commitGuard: () => guard.commitGuard?.(),
                });
              });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `${String(error)}\nEmpty workspace cleanup failed: ${String(cleanupError)}`,
                { cause: cleanupError },
              );
            }
          }
          throw error;
        }
      }),
    );
  }

  private async reserveForOwner(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
    allocation: WorktreeAllocationGuard,
    repository: ResolvedRepository,
    publication: WorktreeCreationPublication,
  ): Promise<WorktreeCreation> {
    return await withWorktreeSource({ ...params, ...allocation }, (current) =>
      createOwnedWorktree(
        { ...current, retainSources: params.retainSources },
        repository,
        this.env,
        this.now,
        (name) => this.reserveForRepository(params, current, repository, name, publication),
      ),
    );
  }

  async rollbackPreparation(
    prepared: ManagedWorktreeRecord,
    withRollback?: CreateManagedWorktreeParams["withRollback"],
  ): Promise<void> {
    return withWorktreeRunEnd(this.env, async () => {
      // Match creation's allocation → checkout order, without retaining a canceled caller.
      await this.withAllocationLease({ id: prepared.id }, async (allocation) => {
        const remove = async (assertCheckoutCurrent?: () => void) => {
          const commitGuard = () => {
            allocation.commitGuard?.();
            assertCheckoutCurrent?.();
          };
          commitGuard();
          const current = await readRegistryWorktreeForMutation({
            env: this.env,
            id: prepared.id,
            commitGuard,
          });
          if (
            !current ||
            current.removedAt !== undefined ||
            current.path !== prepared.path ||
            current.repoRoot !== prepared.repoRoot ||
            current.repoFingerprint !== prepared.repoFingerprint ||
            current.branch !== prepared.branch ||
            current.baseRef !== prepared.baseRef ||
            current.ownerKind !== prepared.ownerKind ||
            current.ownerId !== prepared.ownerId ||
            current.createdAt !== prepared.createdAt ||
            current.lastActiveAt !== prepared.lastActiveAt
          ) {
            throw new Error("Worktree changed before preparation rollback; checkout preserved.");
          }
          // The existing removal claim owns later changes, including its recovery snapshot.
          await this.removeWithAllocation(
            {
              id: prepared.id,
              reason: "session-create-failed",
              // Restored data requires a fresh recovery snapshot before checkout deletion.
              allowSnapshotLoss: prepared.snapshotRef === undefined,
              signal: allocation.signal,
              commitGuard,
              workerAuthority: {
                ...allocation.workerAuthority,
                assertCurrent: () => {
                  allocation.workerAuthority?.assertCurrent?.();
                  assertCheckoutCurrent?.();
                },
              },
              rollbackGuard: allocation.rollbackGuard,
              requireDiskSpace: allocation.requireDiskSpace,
            },
            undefined,
          );
        };
        await (withRollback ? withRollback(remove) : remove());
      });
    });
  }

  private async withAllocationLease<T>(
    params: WorktreeMutationGuard & { id?: string },
    run: (guard: WorktreeAllocationGuard) => Promise<T>,
  ): Promise<T> {
    return await withWorktreeAllocationLease({ ...params, env: this.env }, run);
  }

  private async reserveForRepository(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
    allocation: WorktreeAllocationGuard,
    repository: Awaited<ReturnType<typeof resolveRepository>>,
    inferredName: string,
    publication: WorktreeCreationPublication,
  ): Promise<WorktreeCreation> {
    params.signal?.throwIfAborted();
    params.onProgress?.("checkout");
    const slots = await readPendingWorktrees(this.env);
    const collision = slots.find(
      ({ record, state }) =>
        (params.name &&
          record.repoFingerprint === repository.fingerprint &&
          record.name === params.name) ||
        (state === "pending" && params.ownerId && worktreeOwnerMatches(record, params)),
    );
    if (collision) {
      if (collision.state === "pending" && worktreeOwnerMatches(collision.record, params)) {
        throw new WorktreePendingContentionError(collision.record.id);
      }
      throw new Error(
        `Interrupted worktree creation retained at ${collision.record.path}; inspect its Git registration and choose an unused name before retrying.`,
      );
    }
    const suppliedName = params.name === undefined ? undefined : validateName(params.name);
    // Names belong to the repository across storage roots. Reuse and restore must
    // keep their recorded paths even when the new allocation volume is unavailable.
    const existing = suppliedName
      ? await findWorktreeByName(this.env, repository.fingerprint, suppliedName)
      : undefined;
    if (existing && params.profiles?.length) {
      throw new Error("Source profiles require a new worktree; choose an unused --name.");
    }
    // Name reuse only ever adopts the caller's own record. Without this guard a
    // caller-chosen name could bind a new owner to another session's or a
    // manual checkout and run inside it.
    if (
      existing &&
      (!existing.removedAt || existing.snapshotRef) &&
      !worktreeOwnerMatches(existing, params)
    ) {
      throw new Error(
        `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${suppliedName}`,
      );
    }
    if (existing && existing.removedAt === undefined) {
      if (await worktreePathExists(existing.path)) {
        return {
          record: await rebindLiveWorktreeRepository(this.env, existing, allocation),
          materialized: false,
        };
      }
      await updateRegistryWorktree(
        this.env,
        existing.id,
        { removedAt: this.now() },
        {
          workerAuthority: {
            ...allocation.workerAuthority,
            predicates: [
              ...(allocation.workerAuthority.predicates ?? []),
              { kind: "binding", record: existing },
            ],
          },
        },
      );
    }
    if (existing && existing.removedAt !== undefined && existing.snapshotRef) {
      const record = await withWorktreeMutationLease(
        { ...allocation, env: this.env, id: existing.id },
        (guard) => this.restoreWithAllocation({ ...guard, id: existing.id }),
      );
      publication.record = { ...record };
      return { record, materialized: true };
    }
    const destination = await prepareWorktreeDestination({
      env: this.env,
      configuredRoot: this.getConfig?.().worktreeRoot,
      repository,
      owner: params,
      suppliedName,
      suggestedName: params.suggestedName ?? inferredName,
    });
    await params.retainSources([destination.worktreePath]);
    await this.capacity.admit(allocation);
    const createdAt = this.now();
    const pending: ManagedWorktreeRecord = {
      id: publication.id,
      name: destination.name,
      repoFingerprint: repository.fingerprint,
      repoRoot: repository.repoRoot,
      path: destination.worktreePath,
      branch: destination.branch,
      baseRef: params.baseRef ?? "HEAD",
      ownerKind: params.ownerKind ?? "manual",
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      createdAt,
      lastActiveAt: createdAt,
    };
    publication.pending = pending;
    await reservePendingWorktree(this.env, pending, allocation.workerAuthority);
    return () =>
      this.createReservedRepository(params, repository, destination, pending, publication);
  }

  private async createReservedRepository(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
    repository: ResolvedRepository,
    destination: Awaited<ReturnType<typeof prepareWorktreeDestination>>,
    pending: ManagedWorktreeRecord,
    publication: WorktreeCreationPublication,
  ): Promise<ManagedWorktreeCreationOutcome> {
    let prepared = false;
    try {
      const materialized = await withWorktreeSource(params, async (current) => {
        const created = await this.materializeRepositoryWorktree(
          { ...current, retainSources: params.retainSources },
          repository,
          destination,
          publication,
        );
        prepared = true;
        return created;
      });
      const provisionedPaths = await this.completeRepositoryWorktreeSetup(
        params,
        repository,
        materialized,
      );
      return await this.withAllocationLease(params, (allocation) =>
        withWorktreeSource({ ...params, ...allocation }, async (current) => {
          current.signal?.throwIfAborted();
          current.commitGuard?.();
          await requireAllocationSpace(current, this.env, materialized.worktreePath, repository);
          current.commitGuard();
          const record = { ...pending, baseRef: materialized.recordBase };
          await insertRegistryWorktree(this.env, record, {
            pendingId: pending.id,
            provisionedPaths,
            workerAuthority: current.workerAuthority,
          });
          publication.pending = undefined;
          publication.record = { ...record };
          current.commitGuard();
          return { record, materialized: true };
        }),
      );
    } catch (error) {
      const failures = [error];
      if (prepared && !publication.record && !hasWorktreeUnknownOutcome(error)) {
        try {
          const { worktreePath, branch } = destination;
          const cleanup = async (assertCheckoutCurrent?: () => void) => {
            const commitGuard = () => {
              params.rollbackGuard();
              assertCheckoutCurrent?.();
            };
            const published = await readRegistryWorktreeForMutation({
              env: this.env,
              id: pending.id,
              commitGuard,
            });
            if (published) {
              publication.record = published;
              return;
            }
            const failure = await removeFailedWorktree(
              repository.repoRoot,
              worktreePath,
              branch,
              commitGuard,
            );
            if (failure) {
              throw failure;
            }
          };
          await (params.withRollback ? params.withRollback(cleanup) : cleanup());
        } catch (cleanupError) {
          failures.push(
            new Error(`failed to clean up worktree creation: ${String(cleanupError)}`, {
              cause: cleanupError,
            }),
          );
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, failures.map(String).join("\n"), { cause: error });
      }
      throw error;
    }
  }

  private async materializeRepositoryWorktree(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
    repository: ResolvedRepository,
    destination: Awaited<ReturnType<typeof prepareWorktreeDestination>>,
    publication: WorktreeCreationPublication,
  ): Promise<MaterializedRepositoryWorktree> {
    const { root, worktreePath, branch } = destination;
    // Default-base resolution fetches remote refs; it is an effect, not just discovery.
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    await requireAllocationSpace(params, this.env, worktreePath, repository);
    params.commitGuard?.();
    if (params.checkoutCommit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.checkoutCommit)) {
      throw new Error("Worktree checkout commit is invalid");
    }
    const base = params.checkoutCommit
      ? {
          commit: params.checkoutCommit,
          gitOperand: params.checkoutCommit,
          recordRef: params.baseRef ?? params.checkoutCommit,
          fetchSucceeded: undefined,
          warning: undefined,
        }
      : await resolveWorktreeBase(
          repository.repoRoot,
          params.baseRef,
          params.signal,
          params.commitGuard,
          "fast-forward",
        );
    let gitBytes = 0;
    const provisionedBytes =
      params.provisionIgnoredFiles === false
        ? 0
        : (
            await runGitWorkerOperation(
              {
                type: "worktree.provisioning-inspection",
                input: { sourceRoot: repository.sourceRoot },
              },
              { signal: params.signal, assertCurrent: params.commitGuard },
            )
          ).estimatedBytes;
    const setupStat =
      params.runSetupScript === false
        ? undefined
        : await fs
            .stat(path.join(repository.sourceRoot, ".openclaw", "worktree-setup.sh"))
            .catch(() => undefined);
    const runRepositorySetup = setupStat?.isFile() === true && (setupStat.mode & 0o111) !== 0;
    const setupBytes = runRepositorySetup
      ? Math.max(
          WORKTREE_SETUP_HEADROOM_BYTES,
          await directorySizeBytes(repository.sourceRoot, true, {
            signal: params.signal,
            assertCurrent: params.commitGuard,
          }),
        )
      : 0;
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    const gitBase = params.profiles?.length ? base.commit : base.gitOperand;
    const addCheckout = async () => {
      const sourceProfile = params.profiles?.length
        ? await resolveWorktreeSourceProfile(repository.repoRoot, gitBase, params.profiles, {
            signal: params.signal,
            commitGuard: () => params.commitGuard?.(),
          })
        : undefined;
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      await fs.mkdir(root, { recursive: true });
      return await addManagedWorktree({
        env: this.env,
        now: this.now,
        waitBudget: params.waitBudget,
        enabled: this.getConfig?.().worktreeAcceleration !== false,
        repoRoot: repository.repoRoot,
        commonDir: repository.commonDir,
        worktreeRoot: path.dirname(root),
        destination: worktreePath,
        sourceOnly: params.provisionIgnoredFiles === false,
        branch,
        base: sourceProfile?.commit ?? gitBase,
        sourceProfile,
        prepareCommit: async (commit) => {
          await logWorktreeBase(repository.repoRoot, base, commit, {
            worktreePath,
            ownerId: params.ownerId,
            now: this.now(),
            signal: params.signal,
            assertCurrent: params.commitGuard,
          });
          return (gitBytes = await estimateWorktreeGitBytes(repository.repoRoot, commit, {
            signal: params.signal,
            assertCurrent: params.commitGuard,
          }));
        },
        requireSpace: (cloneBytes) =>
          requireAllocationSpace(
            params,
            this.env,
            worktreePath,
            repository,
            (cloneBytes ?? 2 * gitBytes) + 2 * provisionedBytes + setupBytes,
          ),
        signal: params.signal,
        commitGuard: () => params.commitGuard?.(),
        rollbackGuard: params.rollbackGuard,
        deferUnpreparedCleanup: (cleanup) => {
          publication.cleanup = async (assertCurrent) => {
            assertCurrent();
            const live = await readRegistryWorktrees(this.env, { liveOnly: true });
            assertCurrent();
            if (live.some((record) => record.path === worktreePath)) {
              throw new Error("Worktree was published before cleanup; checkout preserved.");
            }
            await cleanup(assertCurrent);
          };
        },
      });
    };
    const added = await timeWorktreePreparationPhase("checkout", addCheckout);
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    if (added.code !== 0) {
      throw commandError("git worktree add", added);
    }
    return {
      worktreePath,
      recordBase: base.recordRef,
      provisionedBytes,
      setupBytes,
      runRepositorySetup,
    };
  }

  private async completeRepositoryWorktreeSetup(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
    repository: ResolvedRepository,
    materialized: MaterializedRepositoryWorktree,
  ): Promise<string[]> {
    const { worktreePath, provisionedBytes, setupBytes, runRepositorySetup } = materialized;
    const provisionedPaths =
      params.provisionIgnoredFiles === false
        ? []
        : await withWorktreeSource(params, async (current) => {
            current.signal?.throwIfAborted();
            current.commitGuard?.();
            await requireAllocationSpace(
              current,
              this.env,
              worktreePath,
              repository,
              2 * provisionedBytes + setupBytes,
            );
            return provisionIncludedFiles(repository.sourceRoot, worktreePath, {
              signal: current.signal,
              assertCurrent: current.commitGuard,
            });
          });
    if (runRepositorySetup) {
      await requireAllocationSpace(params, this.env, worktreePath, repository, setupBytes);
      await timeWorktreePreparationPhase("setup", () =>
        runSetupScript(repository.sourceRoot, worktreePath, params),
      );
    }
    return provisionedPaths;
  }

  async list(): Promise<ManagedWorktreeRecord[]> {
    return await withWorktreeRunEnd(this.env, async () =>
      reconcileListedWorktrees(this.env, await readRegistryWorktrees(this.env), this.now),
    );
  }

  /** Returns persisted worktree facts without probing paths or mutating lifecycle state. */
  listRegistryRecords = (): Promise<ManagedWorktreeRecord[]> => readRegistryWorktrees(this.env);

  async findLiveByOwner(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
  ): Promise<ManagedWorktreeRecord | undefined> {
    return await readLiveRegistryWorktreeByOwner(
      captureWorktreeRunEndContext(this.env),
      ownerKind,
      ownerId,
    );
  }

  /** Resolves the canonical registry root and the caller's own checkout root. */
  async resolveRepositoryPaths(repoRoot: string): Promise<{
    canonicalRoot: string;
    sourceRoot: string;
  }> {
    const resolved = await resolveRepository(repoRoot);
    return {
      canonicalRoot: resolved.repoRoot,
      sourceRoot: resolved.sourceRoot,
    };
  }

  /** Resolves the repository facts shared by managed worktrees and project discovery. */
  async resolveRepositoryIdentity(repoRoot: string): Promise<{
    checkoutRoot: string;
    repoRoot: string;
    originUrl: string;
    fingerprint: string;
  }> {
    return await resolveRepositoryIdentity(repoRoot);
  }

  async resolveRepositoryIdentities(roots: string[]) {
    return await runGitReadOperation({ type: "repository.identities", input: { roots } });
  }

  /**
   * Lists selectable base refs for a repository without touching the network.
   * Base-ref pickers must stay snappy; resolveWorktreeBase() still fetches on create
   * when no explicit ref is chosen.
   */
  async listRepositoryBranches(
    repoRoot: string,
    options: { includeRepositoryStatus?: boolean } = {},
  ): Promise<ManagedWorktreeBranchesResult> {
    return await runGitReadOperation({
      type: "repository.branches",
      input: { repoRoot, ...options },
    });
  }

  async acquire(id: string, guard: WorktreeMutationGuard = {}): Promise<ManagedWorktreeRecord> {
    return await acquireManagedWorktree(this.env, id, this.now, guard);
  }

  async release(id: string, guard: WorktreeMutationGuard = {}): Promise<void> {
    const record = await readRegistryWorktreeForMutation({ ...guard, env: this.env, id });
    if (!record || record.removedAt !== undefined || !(await worktreePathExists(record.path))) {
      return;
    }
    const state = await lockState(record);
    if (state.kind === "foreign" || (state.kind === "live" && state.pid !== process.pid)) {
      return;
    }
    if (state.kind !== "none") {
      guard.signal?.throwIfAborted();
      guard.commitGuard?.();
      await unlockWorktree(record, { signal: guard.signal, beforeRun: guard.commitGuard });
    }
  }

  async remove(input: RemoveWorktreeParams): Promise<RemoveManagedWorktreeResult> {
    return withWorktreeRunEnd(this.env, async () => {
      let params = input;
      if (params.exactState) {
        if (params.allowSnapshotLoss || params.requireLossless) {
          throw new Error(
            "Exact-state retirement cannot permit snapshot loss or select clean-only removal",
          );
        }
        params = { ...params, exactState: exactStateRetirementSchema.parse(params.exactState) };
      }
      let removalPath: string | undefined;
      let deferral: WorktreeRemovalDeferral | undefined;
      const timing = startGitOperationTiming("worktree-removal", log, () => ({
        id: params.id,
        path: removalPath,
        deferred: deferral ?? false,
      }));
      let outcome: "returned" | "threw" = "threw";
      try {
        const record = requireActiveWorktreeRecord(
          params.id,
          await readRegistryWorktreeForMutation({ ...params, env: this.env }),
        );
        removalPath = record.path;
        // A session mutation must not wait on a remover that needs its final publication fence.
        assertWorktreeRemovalAvailable(this.env, record.id, params.claimToken);
        if (params.withOwnerMutation && !params.claimToken) {
          // Publish custody before taking the checkout lease: a session delete/restore
          // must reject this claim instead of holding the lifecycle while awaiting us.
          params = { ...params, claimToken: await claimManagedRemoval(this.env, record, params) };
        }
        const result = await withWorktreeMutationLease(
          { ...params, id: record.id, env: this.env },
          async (guard) => {
            timing?.markPhase();
            try {
              return await this.removeWithAllocation({ ...params, ...guard }, timing, (value) => {
                deferral = value;
              });
            } finally {
              timing?.markRemovalStage();
              timing?.markPhase();
            }
          },
        );
        outcome = "returned";
        return result;
      } catch (error) {
        if (params.withOwnerMutation && params.claimToken && !hasWorktreeUnknownOutcome(error)) {
          await abortWorktreeRemoval(this.env, params.id, params.claimToken);
        }
        throw error;
      } finally {
        timing?.finish(outcome);
      }
    });
  }

  private async removeWithAllocation(
    params: RemoveWorktreeParams & WorktreeAllocationGuard,
    timing: ReturnType<typeof startGitOperationTiming>,
    onDeferred?: (value: WorktreeRemovalDeferral | undefined) => void,
  ): Promise<RemoveManagedWorktreeResult> {
    timing?.markRemovalStage("preparation");
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    const record = requireActiveWorktreeRecord(
      params.id,
      await readRegistryWorktreeForMutation({ ...params, env: this.env }),
    );
    if (params.exactState) {
      assertExactStateOwner(record, params.exactState);
      const pending = await runGit(
        record.repoRoot,
        ["show-ref", "--verify", "--quiet", `refs/openclaw/removals/${record.id}`],
        { signal: params.signal, beforeRun: params.commitGuard },
      );
      if (pending.code === 0) {
        throw new Error(
          "Previous worktree removal may be incomplete; source and recovery snapshot preserved",
        );
      }
      if (pending.code !== 1) {
        throw commandError("git show-ref", pending);
      }
    }
    const claimToken = params.claimToken ?? (await claimManagedRemoval(this.env, record, params));
    createWorktreeRemovalClaimsGuard(this.env, [record.id], claimToken)();
    try {
      const { withSettledLocalWorkspace } =
        await import("../../gateway/worker-environments/local-workspace-projection.js");
      return await withSettledLocalWorkspace(
        {
          worktree: record,
          env: this.env,
          assertCurrent: params.commitGuard,
          workerAuthority: params.workerAuthority,
          retireRuntime: true,
        },
        (accepted) =>
          removeSettledManagedWorktree(
            {
              ...params,
              claimToken,
              workerAuthority: {
                ...params.workerAuthority,
                ...accepted?.workerAuthority,
                leaseSet: accepted?.workerAuthority.leaseSet ?? params.workerAuthority.leaseSet,
              },
              commitGuard: () => {
                params.commitGuard?.();
                accepted?.assertCurrent();
              },
            },
            {
              env: this.env,
              now: this.now,
              getConfig: this.getConfig ?? getRuntimeConfig,
              snapshotRetentionMs: SNAPSHOT_RETENTION_MS,
            },
            timing,
            accepted?.prepareArchive,
          ),
      );
    } catch (error) {
      timing?.markRemovalFailure();
      timing?.markRemovalStage("finalization");
      if (hasWorktreeUnknownOutcome(error)) {
        throw error;
      }
      let failure = error;
      try {
        if (timing && isWorktreeRemovalTimeout(error)) {
          const progress = timing.removalProgress();
          const deferred = await deferFailedWorktreeRemoval({
            env: this.env,
            id: record.id,
            ...progress,
            reason: `Git ${progress.stage} timed out; cleanup deferred`,
            now: this.now(),
            previousAttempts: record.gcRetry?.attempts ?? 0,
            claimToken,
            assertCurrent: params.rollbackGuard,
          });
          onDeferred?.(deferred);
        }
      } catch (deferralError) {
        if (hasWorktreeUnknownOutcome(deferralError)) {
          throw deferralError;
        }
        failure = new AggregateError(
          [error, deferralError],
          "Worktree removal and timeout recording failed",
          { cause: deferralError },
        );
      }
      await abortWorktreeRemoval(this.env, record.id, claimToken);
      throw failure;
    }
  }

  async recoverRemoval(params: { id: string; snapshot: string } & WorktreeMutationGuard) {
    return withWorktreeRunEnd(this.env, async () => {
      const { recoverManagedWorktreeRemoval } = await import("./removal-recovery.js");
      return await recoverManagedWorktreeRemoval(params, { env: this.env, now: this.now });
    });
  }

  async retireSnapshot(params: RetireManagedWorktreeSnapshotParams) {
    return withWorktreeRunEnd(this.env, () => retireManagedWorktreeSnapshotById(params, this.env));
  }

  async restore(
    params: { id: string; recoverExactState?: ExactStateRetirement } & WorktreeMutationGuard,
  ): Promise<ManagedWorktreeRecord> {
    return await withWorktreeRunEnd(this.env, async () => {
      const record = requireManagedWorktreeRestoreRecord(
        params.id,
        await readRegistryWorktreeForMutation({ ...params, env: this.env }),
      );
      return await this.withAllocationLease({ ...params, id: record.id }, (guard) =>
        this.restoreWithAllocation({ ...params, ...guard, id: record.id }),
      );
    });
  }

  private async restoreWithAllocation(
    params: { id: string; recoverExactState?: ExactStateRetirement } & WorktreeAllocationGuard,
  ): Promise<ManagedWorktreeRecord> {
    return await restoreManagedWorktreeSnapshot(params, {
      env: this.env,
      now: this.now,
      getConfig: this.getConfig,
      admitCapacity: () => this.capacity.admit(params),
    });
  }

  async removeIfLossless(id: string, guard: WorktreeMutationGuard = {}): Promise<boolean> {
    return withWorktreeRunEnd(this.env, async () => {
      guard.signal?.throwIfAborted();
      guard.commitGuard?.();
      return await removeWorktreeIfLossless({
        ...guard,
        record: requireActiveWorktreeRecord(
          id,
          await readRegistryWorktreeForMutation({ ...guard, env: this.env, id }),
        ),
        env: this.env,
        now: this.now,
        getConfig: this.getConfig ?? getRuntimeConfig,
        prepareRecord: (record) => rebindLiveWorktreeRepository(this.env, record, guard),
        remove: async (params) => {
          await this.release(id, guard);
          return await this.remove({
            ...guard,
            ...params,
            reason: "run-end",
            requireLossless: true,
            runEndCleanup: { outcome: "removed-lossless", at: this.now() },
          });
        },
      });
    });
  }

  async removeIfLosslessByPath(
    worktreePath: string,
    owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
    guard: WorktreeMutationGuard = {},
  ): Promise<boolean> {
    const record = await readLiveRegistryWorktreeByPath(
      captureWorktreeRunEndContext(this.env),
      worktreePath,
    );
    if (!record || !worktreeOwnerMatches(record, owner)) {
      return false;
    }
    return await this.removeIfLossless(record.id, guard);
  }

  async releaseByPath(worktreePath: string, guard: WorktreeMutationGuard = {}): Promise<void> {
    const record = await readLiveRegistryWorktreeByPath(
      captureWorktreeRunEndContext(this.env),
      worktreePath,
    );
    if (record) {
      await this.release(record.id, guard);
    }
  }

  async gc(params: ManagedWorktreeGcParams = {}): Promise<ManagedWorktreeGcResult> {
    return withWorktreeRunEnd(this.env, async () => {
      const assertCurrent = () => {
        params.signal?.throwIfAborted();
        params.commitGuard?.();
      };
      assertCurrent();
      const now = this.now();
      const prefilter = createWorktreeGcPrefilter();
      const progress = new WorktreeGcProgress();
      for (const error of await retryWorktreeCapacityReleases(this.env)) {
        progress.error("limits", error);
      }
      assertCurrent();
      const { records, leases } = await readWorktreeCleanupState(this.env);
      const classification = { ...params, ...(await params.prepareOwners?.(records)) };
      assertCurrent();
      const liveIds = new Set(
        records.filter((record) => record.removedAt === undefined).map((record) => record.id),
      );
      for (const id of this.cleanupDeferrals.keys()) {
        if (!liveIds.has(id)) {
          this.cleanupDeferrals.delete(id);
        }
      }
      const liveLeaseScopes = new Set(leases.liveScopes);
      const observedIds = new Set(records.map((record) => record.id));
      const hasLiveLease = (id: string) =>
        observedIds.has(id)
          ? liveLeaseScopes.has(worktreeRunLeaseScope(id))
          : hasLiveWorktreeRunLease(this.env, id);
      const protect = (record: ManagedWorktreeRecord) =>
        autoRemovalProtectionReason(
          record,
          prefilter,
          hasLiveLease,
          {
            env: this.env,
            getConfig: this.getConfig ?? getRuntimeConfig,
            signal: params.signal,
            beforeRun: assertCurrent,
            deferrals: this.cleanupDeferrals,
            now,
          },
          classification,
        );
      const { remove, retireMissing, onError, repositoryProtection } = createWorktreeGcRemoval({
        env: this.env,
        records,
        now,
        progress,
        policy: params,
        signal: params.signal,
        assertCurrent,
        remove: (input) => this.remove(input),
      });
      await this.capacity.cleanup({
        records,
        hasLiveLease,
        progress,
        guard: params,
        checkpoint: () => params.checkpoint?.(progress.result) ?? Promise.resolve(),
      });
      // Keep cold classification serial: each candidate can request several Git processes.
      const evictedIds = new Set(progress.result.removed);
      for (const record of records) {
        assertCurrent();
        if (evictedIds.has(record.id)) {
          continue;
        }
        let retiredOwner = false;
        try {
          if (record.removedAt === undefined && !(await worktreePathExists(record.path))) {
            const retired = await retireMissing(record);
            if (retired.protection) {
              progress.protect("idle", record.id, retired.protection);
            } else if (retired.record?.removedAt === now) {
              progress.result.orphansRetired += 1;
            }
            continue;
          }
          // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
          const expiresWhenIdle =
            record.ownerKind === "workboard" || record.ownerKind === "session";
          if (record.removedAt !== undefined || !expiresWhenIdle) {
            continue;
          }
          retiredOwner =
            record.ownerId !== undefined &&
            classification.shouldRemoveOwner?.(record.ownerKind, record.ownerId) === true;
          if (retiredOwner || now - record.lastActiveAt > IDLE_GC_MS) {
            // Capacity eviction and idle cleanup share one decision per record per pass.
            if (!progress.start(record.id)) {
              continue;
            }
            const repositoryReason = repositoryProtection(record.repoRoot);
            if (repositoryReason) {
              progress.protect("idle", record.id, repositoryReason);
              continue;
            }
            const protection = await protect(record);
            if (protection !== undefined) {
              progress.protect("idle", record.id, protection);
              continue;
            }
            await remove(record, retiredOwner ? "owner-gc" : "idle-gc", retiredOwner);
            progress.result.removed.push(record.id);
          }
        } catch (error) {
          await onError(record, error, retiredOwner);
        } finally {
          await params.checkpoint?.(progress.result);
        }
      }
      try {
        if (await hasTemplatesAsync(this.env)) {
          await collectWorktreeTemplates(
            this.env,
            now - IDLE_GC_MS,
            { signal: params.signal, commitGuard: assertCurrent },
            (error, id) => progress.error("templates", error, id),
          );
        }
      } catch (error) {
        assertCurrent();
        progress.error("templates", error);
        log.warn(`worktree template cleanup deferred: ${String(error)}`);
      }
      const { orphansDeleted, snapshotsPruned } = await collectRetiredWorktreeArtifacts({
        env: this.env,
        getConfig: this.getConfig,
        records,
        expiresBefore: now - SNAPSHOT_RETENTION_MS,
        progress,
        withAllocationLease: (run) => this.withAllocationLease(params, run),
      });
      try {
        await reapWorktreeRunLeases(this.env, leases.staleScopes, assertCurrent);
      } catch (error) {
        progress.error("idle", error);
      }
      progress.result.orphansDeleted = orphansDeleted;
      progress.result.snapshotsPruned = snapshotsPruned;
      assertCurrent();
      // Cleanup has released allocation ownership and retired its refs before maintenance.
      await this.maintainGit({ ...params, shouldDeferRepository: repositoryProtection });
      assertCurrent();
      return progress.result;
    });
  }
}

export const managedWorktrees = new ManagedWorktreeService({ getConfig: getRuntimeConfig });

export type {
  CreateManagedWorktreeParams,
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "./types.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
