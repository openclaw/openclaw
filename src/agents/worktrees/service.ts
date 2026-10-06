import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { startGitOperationTiming } from "../../infra/git-operation-timing.js";
import { runGitReadOperation } from "../../infra/git-read-cache.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOutsideCommandProcessScope } from "../../process/exec-spawn.js";
import {
  withWorktreeAllocationLease,
  withWorktreeMutationLease,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import { resolveWorktreeBase } from "./base-ref.js";
import { createWorktreeCapacityOwner } from "./capacity-owner.js";
import {
  directorySizeBytes,
  estimateWorktreeGitBytes,
  requireAllocationSpace,
  retryWorktreeCapacityReleases,
  WORKTREE_SETUP_HEADROOM_BYTES,
} from "./capacity.js";
import { withManagedWorktreeGit } from "./checkout-policy.js";
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import { addManagedWorktree } from "./checkout.js";
import { ensureEmptyWorktreeSource, removeUnusedEmptyWorktreeSource } from "./empty-source.js";
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
import { commandError, worktreePathExists, runGit, requireGit } from "./git.js";
import { validateName } from "./name.js";
import { worktreeOwnerMatches } from "./owner.js";
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
} from "./registry-read.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  findLiveRegistryWorktreeByOwner,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  insertRegistryWorktree,
  createWorktreeRemovalClaimsGuard,
  updateRegistryWorktree,
} from "./registry.js";
import { WorktreeSnapshotError, WorktreeRemovalLockError } from "./removal-errors.js";
import { finalizeManagedWorktreeRemoval } from "./removal-finalization.js";
import {
  assertExactStateOwner,
  prepareSnapshotBranchDeletion,
  removeManagedCheckout,
  requireExactManagedWorktreeHead,
  retireExactWorktree,
  requireManagedWorktreeHead,
} from "./removal-git.js";
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
  canResetFailedWorktreeAdd,
  cleanupFailedCreate,
  createWithWorktreeAllocation,
  createOwnedWorktree,
  acquireManagedWorktree,
  prepareWorktreeDestination,
  findWorktreeByName,
  resetFailedWorktreeAdd,
  resolveRepository,
  rebindLiveWorktreeRepository,
  resolveRepositoryIdentity,
  runSetupScript,
  withWorktreeSource,
  withWorktreeSources,
  type ResolvedRepository,
  type WorktreeCreationPublication,
  type WorktreeSourceCustody,
} from "./service-preparation.js";
import {
  exactStateRetirementSchema,
  type ExactStateRetirement,
} from "./snapshot-exact-state-contract.js";
import {
  captureManagedWorktreeSnapshot,
  retireManagedWorktreeSnapshotById,
  verifyManagedWorktreeExactSnapshot,
} from "./snapshot-host.js";
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
  ManagedWorktreeRunEndCleanup,
  RemoveManagedWorktreeResult,
  RetireManagedWorktreeSnapshotParams,
  WorktreeWorkerAuthority,
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

type WorktreeMutationGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
  workerAuthority?: WorktreeWorkerAuthority;
};

type RemoveWorktreeParams = WorktreeMutationGuard & {
  id: string;
  reason: string;
  allowSnapshotLoss?: boolean;
  /** Explicit owner-fenced detached retirement; never combined with force or clean-only removal. */
  exactState?: ExactStateRetirement;
  requireLossless?: boolean;
  inspectedHead?: string;
  claimToken?: string;
  rollbackGuard?: () => void;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};
type MaterializedRepositoryWorktree = {
  name: string;
  worktreePath: string;
  branch: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};

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
      withWorktreeRunEnd(this.env, () => this.createWithOutcomeAccepted(params)),
    );
  }

  private async createWithOutcomeAccepted(
    params: CreateManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    params.signal?.throwIfAborted();
    const repository = await resolveRepository(params.repoRoot);
    return await createWithWorktreeAllocation(
      { ...params, env: this.env },
      async (guard, publication) =>
        await withWorktreeSources(
          { ...params, ...guard, env: this.env, repository },
          (retainSources) =>
            this.createForOwner({ ...params, ...guard, retainSources }, repository, publication),
        ),
      (record) => this.rollbackPreparation(record, params.withRollback),
    );
  }

  async createEmpty(params: CreateEmptyManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    return (await this.createEmptyWithOutcome(params)).record;
  }

  async createEmptyWithOutcome(
    params: CreateEmptyManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    return withWorktreePreparationTiming("managed", () =>
      withWorktreeRunEnd(this.env, () => this.createEmptyWithOutcomeAccepted(params)),
    );
  }

  private async createEmptyWithOutcomeAccepted(
    params: CreateEmptyManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    let sourceRoot: string | undefined;
    try {
      return await createWithWorktreeAllocation(
        { ...params, env: this.env },
        async (guard, publication) => {
          const repoRoot = await ensureEmptyWorktreeSource({
            env: this.env,
            ownerId: params.ownerId,
            signal: guard.signal,
            commitGuard: () => guard.commitGuard?.(),
          });
          sourceRoot = repoRoot;
          const repository = await resolveRepository(repoRoot);
          const creation = {
            ...params,
            ...guard,
            repoRoot,
            baseRef: "main",
            runSetupScript: false,
          };
          return await withWorktreeSources(
            { ...creation, env: this.env, repository },
            (retainSources) =>
              this.createForOwner({ ...creation, retainSources }, repository, publication),
          );
        },
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
  }

  private async createForOwner(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
    repository: ResolvedRepository,
    publication: WorktreeCreationPublication,
  ): Promise<ManagedWorktreeCreationOutcome> {
    return await createOwnedWorktree(params, repository, this.env, this.now, (name) =>
      this.createForRepository(params, repository, name, publication),
    );
  }

  async rollbackPreparation(
    prepared: ManagedWorktreeRecord,
    withRollback?: CreateManagedWorktreeParams["withRollback"],
  ): Promise<void> {
    return withWorktreeRunEnd(this.env, () =>
      this.rollbackPreparationAccepted(prepared, withRollback),
    );
  }

  private async rollbackPreparationAccepted(
    prepared: ManagedWorktreeRecord,
    withRollback?: CreateManagedWorktreeParams["withRollback"],
  ): Promise<void> {
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
      if (withRollback) {
        await withRollback(remove);
      } else {
        await remove();
      }
    });
  }

  private async withAllocationLease<T>(
    params: WorktreeMutationGuard & { id?: string },
    run: (guard: WorktreeAllocationGuard) => Promise<T>,
  ): Promise<T> {
    return await withWorktreeAllocationLease({ ...params, env: this.env }, run);
  }

  private async createForRepository(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
    repository: Awaited<ReturnType<typeof resolveRepository>>,
    inferredName: string,
    publication: WorktreeCreationPublication,
  ): Promise<ManagedWorktreeCreationOutcome> {
    params.signal?.throwIfAborted();
    params.onProgress?.("checkout");
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
        return await withWorktreeSource(params, async (current) => ({
          record: await rebindLiveWorktreeRepository(this.env, existing, current),
          materialized: false,
        }));
      }
      await withWorktreeSource(params, (current) =>
        updateRegistryWorktree(
          this.env,
          existing.id,
          { removedAt: this.now() },
          {
            workerAuthority: {
              ...current.workerAuthority,
              predicates: [
                ...(current.workerAuthority.predicates ?? []),
                { kind: "binding", record: existing },
              ],
            },
          },
        ),
      );
    }
    if (existing && existing.removedAt !== undefined && existing.snapshotRef) {
      return await withWorktreeSource(params, async (current) => {
        const record = await withWorktreeMutationLease(
          { ...current, env: this.env, id: existing.id },
          (guard) => this.restoreWithAllocation({ ...guard, id: existing.id }),
        );
        publication.record = { ...record };
        return { record, materialized: true };
      });
    }
    let prepared: MaterializedRepositoryWorktree | undefined;
    let publicationStarted = false;
    try {
      const materialized = await withWorktreeSource(params, async (current) => {
        const created = await this.materializeRepositoryWorktree(
          { ...current, retainSources: params.retainSources },
          repository,
          inferredName,
          suppliedName,
          publication,
        );
        prepared = created;
        return created;
      });
      const provisionedPaths = await this.completeRepositoryWorktreeSetup(
        params,
        repository,
        materialized,
      );
      return await withWorktreeSource(params, async (current) => {
        current.signal?.throwIfAborted();
        current.commitGuard?.();
        await requireAllocationSpace(current, this.env, materialized.worktreePath, repository);
        current.commitGuard();
        // Preserve a possibly published record if insertion or source unwind fails.
        publicationStarted = true;
        const { name, worktreePath, branch, recordBase } = materialized;
        const createdAt = this.now();
        const record: ManagedWorktreeRecord = {
          id: randomUUID(),
          name,
          repoFingerprint: repository.fingerprint,
          repoRoot: repository.repoRoot,
          path: worktreePath,
          branch,
          baseRef: recordBase,
          ownerKind: current.ownerKind ?? "manual",
          ...(current.ownerId ? { ownerId: current.ownerId } : {}),
          createdAt,
          lastActiveAt: createdAt,
        };
        await insertRegistryWorktree(this.env, record, {
          provisionedPaths,
          workerAuthority: current.workerAuthority,
        });
        publication.record = { ...record };
        current.commitGuard();
        return { record, materialized: true };
      });
    } catch (error) {
      const failures = [error];
      if (prepared && !publicationStarted) {
        try {
          const { worktreePath, branch } = prepared;
          const cleanup = async (assertCheckoutCurrent?: () => void) =>
            await cleanupFailedCreate(repository.repoRoot, worktreePath, branch, () => {
              params.rollbackGuard();
              assertCheckoutCurrent?.();
            });
          if (params.withRollback) {
            await params.withRollback(cleanup);
          } else {
            await cleanup();
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
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
    inferredName: string,
    suppliedName: string | undefined,
    publication: WorktreeCreationPublication,
  ): Promise<MaterializedRepositoryWorktree> {
    const { root, name, worktreePath, branch } = await prepareWorktreeDestination({
      env: this.env,
      configuredRoot: this.getConfig?.().worktreeRoot,
      repository,
      owner: params,
      suppliedName,
      suggestedName: params.suggestedName ?? inferredName,
    });
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
          remote: false,
        }
      : await resolveWorktreeBase(
          repository.repoRoot,
          params.baseRef,
          params.signal,
          params.commitGuard,
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
    let gitBase = params.profiles?.length ? base.commit : base.gitOperand;
    let recordBase = base.recordRef;
    const addCheckout = async () => {
      // Resolve on every attempt, including the remote-base fallback to local HEAD.
      // Never pair one commit's source selection with another commit's checkout.
      const sourceProfile = params.profiles?.length
        ? await resolveWorktreeSourceProfile(repository.repoRoot, gitBase, params.profiles, {
            signal: params.signal,
            commitGuard: () => params.commitGuard?.(),
          })
        : undefined;
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      await params.retainSources([worktreePath]);
      await this.capacity.admit(params);
      params.commitGuard?.();
      await fs.mkdir(root, { recursive: true });
      return await addManagedWorktree({
        env: this.env,
        now: this.now,
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
    let added = await timeWorktreePreparationPhase("checkout", addCheckout);
    if (added.code !== 0 && base.remote) {
      if (!(await canResetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, added))) {
        throw commandError("git worktree add", added);
      }
      await resetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, params.rollbackGuard);
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      gitBase = "HEAD";
      recordBase = "HEAD";
      added = await timeWorktreePreparationPhase("checkout", addCheckout);
    }
    if (added.code !== 0) {
      throw commandError("git worktree add", added);
    }
    return {
      name,
      worktreePath,
      branch,
      recordBase,
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

  findLiveByOwner(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
  ): ManagedWorktreeRecord | undefined {
    return findLiveRegistryWorktreeByOwner(this.env, ownerKind, ownerId);
  }

  findLiveById(id: string): ManagedWorktreeRecord | undefined {
    const record = getRegistryWorktree(this.env, id);
    return record?.removedAt === undefined ? record : undefined;
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

  async acquire(id: string): Promise<ManagedWorktreeRecord> {
    return await acquireManagedWorktree(this.env, id, this.now);
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
    return withWorktreeRunEnd(this.env, () => this.removeAccepted(input));
  }

  private async removeAccepted(input: RemoveWorktreeParams): Promise<RemoveManagedWorktreeResult> {
    let params = input;
    if (params.exactState) {
      if (params.allowSnapshotLoss || params.requireLossless) {
        throw new Error(
          "Exact-state retirement cannot permit snapshot loss or select clean-only removal",
        );
      }
      params = { ...params, exactState: exactStateRetirementSchema.parse(params.exactState) };
    }
    const timing = startGitOperationTiming("worktree-removal", log);
    let outcome: "returned" | "threw" = "threw";
    try {
      const record = requireActiveWorktreeRecord(
        params.id,
        await readRegistryWorktreeForMutation({ ...params, env: this.env }),
      );
      const result = await withWorktreeMutationLease(
        { ...params, id: record.id, env: this.env },
        async (guard) => {
          timing?.markPhase();
          try {
            return await this.removeWithAllocation({ ...params, ...guard }, timing);
          } finally {
            timing?.markRemovalStage();
            timing?.markPhase();
          }
        },
      );
      outcome = "returned";
      return result;
    } finally {
      timing?.finish(outcome);
    }
  }

  private async removeWithAllocation(
    params: RemoveWorktreeParams & WorktreeAllocationGuard,
    timing: ReturnType<typeof startGitOperationTiming>,
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
    const claimToken = params.claimToken ?? randomUUID();
    await claimWorktreeRemoval(this.env, {
      worktreeId: record.id,
      token: claimToken,
      assertCurrent: params.commitGuard,
      workerAuthority: {
        ...params.workerAuthority,
        assertCurrent: params.workerAuthority
          ? params.workerAuthority.assertCurrent
          : params.commitGuard,
        predicates: [...(params.workerAuthority?.predicates ?? []), { kind: "binding", record }],
      },
    });
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
          this.removeSettledWithAllocation(
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
            timing,
            accepted?.prepareArchive,
          ),
      );
    } catch (error) {
      timing?.markRemovalStage("finalization");
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      await abortWorktreeRemoval(this.env, record.id, claimToken);
      throw error;
    }
  }

  private async removeSettledWithAllocation(
    input: RemoveWorktreeParams & WorktreeAllocationGuard,
    timing: ReturnType<typeof startGitOperationTiming>,
    prepareArchive?: (snapshot: string) => Promise<void>,
  ): Promise<RemoveManagedWorktreeResult> {
    let params = input;
    timing?.markRemovalStage("preparation");
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    let record = requireActiveWorktreeRecord(
      params.id,
      await readRegistryWorktreeForMutation({ ...params, env: this.env }),
    );
    // Claim removal before any cleanliness or snapshot work so a live run lease
    // rejects it and an admitted run cannot start once the claim is held. The
    // opaque token makes the claim exclusive against competing removers; a caller
    // that already claimed (removeIfLossless) passes its token to keep one claim.
    const claimToken = params.claimToken!;
    const assertClaim = createWorktreeRemovalClaimsGuard(this.env, [record.id], claimToken);
    const allocationGuard = params.commitGuard;
    let exactFinalized = false;
    if (params.exactState) {
      const expected = params.exactState;
      const original = record;
      params = {
        ...params,
        workerAuthority: {
          ...params.workerAuthority,
          predicates: [
            ...(params.workerAuthority?.predicates ?? []),
            { kind: "exact-owner", record: original },
          ],
        },
        commitGuard: () => {
          allocationGuard?.();
          if (exactFinalized) {
            return;
          }
          const current = this.requireLiveRecord(params.id);
          assertExactStateOwner(current, expected);
          if (
            current.path !== original.path ||
            current.branch !== original.branch ||
            current.repoRoot !== original.repoRoot
          ) {
            throw new Error("Worktree exact-state binding changed; checkout preserved");
          }
          assertClaim();
        },
      };
    }
    record = await rebindLiveWorktreeRepository(this.env, record, params);
    const gitOptions = {
      signal: params.signal,
      beforeRun: params.commitGuard,
      killProcessTree: true,
    };
    return await withManagedWorktreeGit(
      { record, env: this.env, getConfig: this.getConfig ?? getRuntimeConfig, ...gitOptions },
      async (git) => {
        const pendingRef = `refs/openclaw/removals/${record.id}`;
        const pending = await git.run(
          record.repoRoot,
          ["show-ref", "--verify", "--quiet", pendingRef],
          gitOptions,
        );
        if (pending.code !== 1) {
          if (pending.code !== 0) {
            throw commandError("git show-ref --verify", pending);
          }
          throw new Error(
            `Previous worktree removal may be incomplete; inspect ${record.path} before cleanup. Recovery snapshot preserved at ${pendingRef}.`,
          );
        }
        const checkHead = () =>
          params.exactState
            ? requireExactManagedWorktreeHead(record, params.exactState, gitOptions)
            : requireManagedWorktreeHead(record, gitOptions);
        const head = await checkHead();
        if (params.inspectedHead && params.inspectedHead !== head) {
          throw new Error("Worktree HEAD changed after lossless inspection; checkout preserved.");
        }
        const state = await lockState(record);
        if (state.kind === "live" || state.kind === "foreign") {
          throw new WorktreeRemovalLockError(
            state.kind === "live" ? "busy" : "foreign-lock",
            state.kind === "live"
              ? `worktree is locked by live OpenClaw pid ${state.pid}`
              : `worktree has a foreign lock${state.reason ? `: ${state.reason}` : ""}`,
          );
        }
        if (state.kind !== "none") {
          params.commitGuard?.();
          await git.require(record.repoRoot, ["worktree", "unlock", record.path], {
            signal: params.signal,
            beforeRun: params.commitGuard,
            killProcessTree: true,
          });
        }
        timing?.markRemovalStage("snapshot");
        const retirementName = params.exactState ? `.openclaw-retiring-${randomUUID()}` : undefined;
        let snapshotRef: string | undefined;
        let snapshotError: string | undefined;
        let exactStateDigest: string | undefined;
        let capturedProvisionedPaths: readonly string[] = [];
        try {
          const provisionedPaths = await getRegistryWorktreeProvisionedPaths(this.env, record.id);
          params.commitGuard?.();
          if (provisionedPaths === undefined) {
            throw new Error("provisioned path ledger is unavailable");
          }
          capturedProvisionedPaths = provisionedPaths;
          const snapshot = await captureManagedWorktreeSnapshot({
            record,
            env: this.env,
            reason: params.reason,
            exactState: params.exactState,
            retirementName,
            provisionedPaths,
            git,
            signal: params.signal,
            assertCurrent: params.commitGuard,
            workerAuthority: {
              ...params.workerAuthority,
              predicates: [
                ...(params.workerAuthority?.predicates ?? []),
                { kind: "removal-claim", id: record.id, token: claimToken },
              ],
            },
            requireDiskSpace: params.requireDiskSpace,
          });
          snapshotRef = snapshot.snapshotRef;
          exactStateDigest = snapshot.exactStateDigest;
          params.commitGuard?.();
          await updateRegistryWorktree(
            this.env,
            record.id,
            { snapshotRef, provisionedState: snapshot.provisionedState },
            {
              workerAuthority: {
                ...params.workerAuthority,
                predicates: [
                  ...(params.workerAuthority.predicates ?? []),
                  { kind: "removal-claim", id: record.id, token: claimToken },
                ],
              },
            },
          );
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          snapshotError = error instanceof Error ? error.message : String(error);
          try {
            params.rollbackGuard();
            await clearRegistryWorktreeProvisionedChunks(this.env, record.id, {
              leaseSet: params.workerAuthority.leaseSet,
              predicates: [{ kind: "removal-claim", id: record.id, token: claimToken }],
            });
          } catch (cleanupError) {
            throw new WorktreeSnapshotError(
              `${snapshotError}; provisioned snapshot cleanup failed: ${String(cleanupError)}`,
              { cause: cleanupError },
            );
          }
          if (!params.allowSnapshotLoss) {
            throw new WorktreeSnapshotError(snapshotError, { cause: error });
          }
          snapshotRef = undefined;
        }
        const snapshot =
          snapshotError || !snapshotRef
            ? undefined
            : await git.require(
                record.repoRoot,
                ["rev-parse", "--verify", `${snapshotRef}^{commit}`],
                gitOptions,
              );
        const deletionOptions =
          snapshot && snapshotRef && !params.exactState
            ? await prepareSnapshotBranchDeletion(record, snapshotRef, snapshot, gitOptions)
            : undefined;
        if (
          (await checkHead()) !== head ||
          (snapshot &&
            (await git.require(record.repoRoot, ["rev-parse", `${snapshot}^`], gitOptions)) !==
              head)
        ) {
          throw new Error(
            "Worktree HEAD changed after snapshot preparation; checkout and branch preserved.",
          );
        }
        timing?.markRemovalStage("checkoutRemoval");
        params.signal?.throwIfAborted();
        params.commitGuard?.();
        if (params.requireLossless && snapshot) {
          // The snapshot sees hidden index edits that status alone can miss.
          const changed = await git.require(
            record.repoRoot,
            ["diff-tree", "--no-commit-id", "--name-only", "-r", head, snapshot],
            gitOptions,
          );
          if (changed) {
            await abortWorktreeRemoval(this.env, record.id, claimToken);
            await updateRegistryWorktree(
              this.env,
              record.id,
              {
                runEndCleanup: { outcome: "retained-dirty", at: this.now() },
              },
              {
                onlyIfLive: true,
                onlyIfActiveAt: record.lastActiveAt,
                workerAuthority: params.workerAuthority,
              },
            );
            return { removed: false };
          }
        }
        if (snapshot) {
          await prepareArchive?.(snapshot);
        }
        // Pin the completed capture before deletion. Failed or interrupted deletion
        // must never replace it with a snapshot of a partially removed checkout.
        await git.require(
          record.repoRoot,
          ["update-ref", pendingRef, snapshot ?? head, ""],
          gitOptions,
        );
        const finalize = async (recoveryPath?: string) => {
          timing?.markRemovalStage("finalization");
          return await finalizeManagedWorktreeRemoval({
            record,
            env: this.env,
            claimToken,
            now: this.now,
            snapshotRef,
            snapshotOid: snapshot ?? head,
            snapshotError,
            runEndCleanup: params.runEndCleanup,
            recoveryPath,
            snapshotRetentionMs: SNAPSHOT_RETENTION_MS,
            git: params.exactState ? git.require : requireGit,
            options: params.exactState
              ? gitOptions
              : {
                  ...gitOptions,
                  signal: undefined,
                  beforeRun: () => {
                    params.rollbackGuard();
                    assertClaim();
                  },
                },
            deletionOptions,
            onFinalized: () => {
              exactFinalized = true;
            },
            workerAuthority: {
              leaseSet: params.workerAuthority.leaseSet,
              predicates: [{ kind: "removal-claim", id: record.id, token: claimToken }],
            },
          });
        };
        const expected = params.exactState;
        if (expected) {
          const digest = exactStateDigest;
          const rollbackGuard = params.rollbackGuard;
          if (!retirementName || !snapshot || !digest || !rollbackGuard) {
            throw new Error(
              "Exact-state snapshot or retirement custody is incomplete; source preserved",
            );
          }
          return await retireExactWorktree({
            record,
            retirementName,
            snapshot,
            git,
            signal: params.signal,
            assertCurrent: () => params.commitGuard?.(),
            assertRollbackCurrent: rollbackGuard,
            finalize,
            verify: async (quarantined) => {
              await verifyManagedWorktreeExactSnapshot({
                record: quarantined,
                expected,
                retirementName,
                expectedDigest: digest,
                provisionedPaths: capturedProvisionedPaths,
                git,
                signal: params.signal,
                assertCurrent: () => params.commitGuard?.(),
              });
              await requireExactManagedWorktreeHead(quarantined, expected, gitOptions);
            },
          });
        }
        await removeManagedCheckout(record, git, params.requireLossless, params.commitGuard);
        // Admitted deletion must publish its terminal facts even after caller cancellation.
        return await runOutsideCommandProcessScope(() => finalize());
      },
    );
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
    return withWorktreeRunEnd(this.env, () => this.removeIfLosslessAccepted(id, guard));
  }

  private async removeIfLosslessAccepted(
    id: string,
    guard: WorktreeMutationGuard,
  ): Promise<boolean> {
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
  }

  async removeIfLosslessByPath(
    worktreePath: string,
    owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  ): Promise<boolean> {
    const record = await readLiveRegistryWorktreeByPath(
      captureWorktreeRunEndContext(this.env),
      worktreePath,
    );
    if (!record || !worktreeOwnerMatches(record, owner)) {
      return false;
    }
    return await this.removeIfLossless(record.id);
  }

  async releaseByPath(worktreePath: string): Promise<void> {
    const record = await readLiveRegistryWorktreeByPath(
      captureWorktreeRunEndContext(this.env),
      worktreePath,
    );
    if (record) {
      await this.release(record.id);
    }
  }

  async gc(params: ManagedWorktreeGcParams = {}): Promise<ManagedWorktreeGcResult> {
    return withWorktreeRunEnd(this.env, () => this.gcAccepted(params));
  }

  private async gcAccepted(params: ManagedWorktreeGcParams): Promise<ManagedWorktreeGcResult> {
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      params.commitGuard?.();
    };
    assertCurrent();
    const now = this.now();
    const prefilter = createWorktreeGcPrefilter();
    const progress = new WorktreeGcProgress();
    const result = progress.result;
    for (const error of await retryWorktreeCapacityReleases(this.env)) {
      progress.error("limits", error);
    }
    assertCurrent();
    const { records, leases } = await readWorktreeCleanupState(this.env);
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
        },
        params,
      );
    const { remove, retireMissing, onError } = createWorktreeGcRemoval({
      env: this.env,
      now,
      progress,
      policy: params,
      signal: params.signal,
      assertCurrent,
      remove: (input) => this.remove(input),
    });
    await this.capacity.cleanup({
      records,
      liveCount: liveIds.size,
      hasLiveLease,
      progress,
      guard: params,
      checkpoint: () => params.checkpoint?.(result) ?? Promise.resolve(),
    });
    // Keep cold classification serial: each candidate can request several Git processes.
    const evictedIds = new Set(result.removed);
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
            result.orphansRetired += 1;
          }
          continue;
        }
        // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
        const expiresWhenIdle = record.ownerKind === "workboard" || record.ownerKind === "session";
        if (record.removedAt !== undefined || !expiresWhenIdle) {
          continue;
        }
        retiredOwner =
          record.ownerId !== undefined &&
          params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) === true;
        if (retiredOwner || now - record.lastActiveAt > IDLE_GC_MS) {
          // Capacity eviction and idle cleanup share one decision per record per pass.
          if (!progress.start(record.id)) {
            continue;
          }
          const protection = await protect(record);
          if (protection !== undefined) {
            progress.protect("idle", record.id, protection);
            continue;
          }
          await remove(record, retiredOwner ? "owner-gc" : "idle-gc", retiredOwner);
          result.removed.push(record.id);
        }
      } catch (error) {
        await onError(record, error, retiredOwner);
      } finally {
        await params.checkpoint?.(result);
      }
    }
    try {
      // Empty caches must not wait behind checkout creation. Collection rereads
      // the templates under the lease before retiring any artifacts.
      if (await hasTemplatesAsync(this.env)) {
        await this.withAllocationLease(params, async (guard) => {
          await collectWorktreeTemplates(
            this.env,
            now - IDLE_GC_MS,
            {
              signal: guard.signal,
              commitGuard: () => guard.commitGuard?.(),
            },
            (error, id) => progress.error("templates", error, id),
          );
        });
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
    result.orphansDeleted = orphansDeleted;
    result.snapshotsPruned = snapshotsPruned;
    assertCurrent();
    // Cleanup has released allocation ownership and retired its refs before maintenance.
    await this.maintainGit(params);
    assertCurrent();
    return result;
  }

  private requireLiveRecord(id: string): ManagedWorktreeRecord {
    return requireActiveWorktreeRecord(id, getRegistryWorktree(this.env, id));
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
