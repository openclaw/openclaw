import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { isMissingPathError, formatErrorMessage } from "../../infra/errors.js";
import { startGitOperationTiming } from "../../infra/git-operation-timing.js";
import { runGitReadOperation } from "../../infra/git-read-cache.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createCrustaceanSlug } from "../session-slug.js";
import { withWorktreeAllocationLease, type WorktreeAllocationGuard } from "./allocation.js";
import { resolveWorktreeBase } from "./base-ref.js";
import {
  directorySizeBytes,
  estimateWorktreeGitBytes,
  requireWorktreeDiskSpace,
  WORKTREE_SETUP_HEADROOM_BYTES,
} from "./capacity.js";
import { inspectManagedWorktreeCheckout } from "./checkout-inspection.js";
import { withManagedWorktreeGit } from "./checkout-policy.js";
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import {
  addManagedWorktree,
  collectWorktreeTemplates,
  WORKTREE_TEMPLATE_DIRECTORY,
} from "./checkout.js";
import { ensureEmptyWorktreeSource, removeUnusedEmptyWorktreeSource } from "./empty-source.js";
import { WorktreeRepositoryError } from "./errors.js";
import { enforceWorktreeCleanupLimits } from "./gc-limits.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { autoRemovalProtectionReason } from "./gc-protection.js";
import {
  createWorktreeLockPrefilter,
  lockState,
  lockWorktreeForProcess,
  unlockWorktree,
} from "./git-lock.js";
import { commandError, worktreePathExists, runGit } from "./git.js";
import { canonicalPathKey, shouldPreserveOrphanCandidate } from "./orphan-paths.js";
import { worktreeOwnerMatches } from "./owner.js";
import { provisionIncludedFiles } from "./provisioned-files.js";
import { readRegistryWorktrees, readWorktreeCleanupState } from "./registry-read.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  findLiveRegistryWorktreeByOwner,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  insertRegistryWorktree,
  listRegistryWorktrees,
  retireMissingRegistryWorktree,
  assertWorktreeRemovalClaim,
  updateRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import {
  WorktreeSnapshotError,
  WorktreeRemovalLockError,
  WorktreeRemovalIncompleteError,
  rethrowWorktreeRemovalFailure,
} from "./removal-errors.js";
import {
  assertExactStateOwner,
  prepareSnapshotBranchDeletion,
  removeManagedCheckout,
  requireWorktreeRemovalRef,
  requireExactManagedWorktreeHead,
  retireExactWorktree,
  requireManagedWorktreeHead,
} from "./removal-git.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import { reapWorktreeRunLeases } from "./run-lease-store.js";
import {
  abortWorktreeRemoval,
  claimWorktreeRemoval,
  finalizeWorktreeRemoval,
  hasLiveWorktreeRunLease,
} from "./run-lease.js";
import { reconcileListedWorktrees } from "./service-list.js";
import {
  canResetFailedWorktreeAdd,
  cleanupFailedCreate,
  findWorktreeByName,
  generateName,
  resetFailedWorktreeAdd,
  resolveRepository,
  resolveRepositoryFromRealPath,
  runSetupScript,
  validateName,
  withWorktreeSource,
  type ResolvedRepository,
} from "./service-preparation.js";
import {
  exactStateRetirementSchema,
  type ExactStateRetirement,
} from "./snapshot-exact-state-contract.js";
import {
  captureManagedWorktreeSnapshot,
  retireManagedWorktreeSnapshot,
  verifyManagedWorktreeExactSnapshot,
} from "./snapshot-host.js";
import { restoreManagedWorktreeSnapshot } from "./snapshot-restore.js";
import { hasTemplates } from "./template-registry.js";
import type {
  CreateEmptyManagedWorktreeParams,
  CreateManagedWorktreeParams,
  ManagedWorktreeBranchesResult,
  ManagedWorktreeCreationOutcome,
  ManagedWorktreeGcResult,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanup,
  ManagedWorktreeRunEndCleanupOutcome,
  RemoveManagedWorktreeResult,
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

export type WorktreeCleanupLimits = {
  maxCount?: number;
  maxTotalSizeBytes?: number;
};

type ManagedWorktreeGcParams = {
  shouldProtectOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  shouldRemoveOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  limits?: WorktreeCleanupLimits;
};

type WorktreeMutationGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard">;
type WorktreeCreationPublication = { record?: ManagedWorktreeRecord };

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
  /** GC pressure must be reread after acquiring the allocation lease. */
  assertCleanupPressure?: () => Promise<void>;
};
const WORKTREE_CLEANUP_TARGET = 100;

/** A bounded default; manual and actively used worktrees remain protected. */
export function resolveWorktreeCleanupLimits(): WorktreeCleanupLimits {
  return { maxCount: WORKTREE_CLEANUP_TARGET };
}

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

  constructor(options: ServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.getConfig = options.getConfig;
  }

  private async worktreesRoot(): Promise<string> {
    const root =
      this.getConfig?.().worktreeRoot ?? path.join(resolveStateDir(this.env), "worktrees");
    await fs.mkdir(root, { recursive: true });
    // Git canonicalizes paths in `git worktree list`; minting below the real root keeps
    // lock-state and adoption comparisons aligned when the state path traverses symlinks.
    return await fs.realpath(root);
  }

  async create(params: CreateManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    return (await this.createWithOutcome(params)).record;
  }

  async createWithOutcome(
    params: CreateManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    params.signal?.throwIfAborted();
    const repository = await resolveRepository(params.repoRoot);
    return await this.createWithAllocation(
      params,
      async (guard, publication) =>
        await this.createForOwner({ ...params, ...guard }, repository, publication),
    );
  }

  async createEmpty(params: CreateEmptyManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    return (await this.createEmptyWithOutcome(params)).record;
  }

  async createEmptyWithOutcome(
    params: CreateEmptyManagedWorktreeParams,
  ): Promise<ManagedWorktreeCreationOutcome> {
    let sourceRoot: string | undefined;
    try {
      return await this.createWithAllocation(params, async (guard, publication) => {
        const repoRoot = await ensureEmptyWorktreeSource({
          env: this.env,
          ownerId: params.ownerId,
          signal: guard.signal,
          commitGuard: () => guard.commitGuard?.(),
        });
        sourceRoot = repoRoot;
        const repository = await resolveRepository(repoRoot);
        return await this.createForOwner(
          { ...params, ...guard, repoRoot, baseRef: "main", runSetupScript: false },
          repository,
          publication,
        );
      });
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
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
    repository: ResolvedRepository,
    publication: WorktreeCreationPublication,
  ): Promise<ManagedWorktreeCreationOutcome> {
    if (params.ownerId) {
      const existing = findLiveRegistryWorktreeByOwner(
        this.env,
        params.ownerKind ?? "manual",
        params.ownerId,
      );
      if (existing && params.profiles?.length) {
        throw new Error("Source profiles require a new worktree; use a new owner and name.");
      }
      if (existing && (await worktreePathExists(existing.path))) {
        return await withWorktreeSource(params, async (current) => {
          const validated = await this.rebindLiveRepository(existing, current);
          if (validated.repoRoot !== repository.repoRoot) {
            throw new Error(
              `worktree owner ${params.ownerKind ?? "manual"} ${params.ownerId} is already bound to another repository`,
            );
          }
          current.commitGuard?.();
          return { record: validated, materialized: false };
        });
      }
      if (existing) {
        await withWorktreeSource(params, (current) => {
          current.commitGuard?.();
          updateRegistryWorktree(this.env, existing.id, { removedAt: this.now() });
        });
      }
    }
    return await this.createForRepository(
      params,
      repository,
      params.name ?? params.suggestedName ?? createCrustaceanSlug(),
      publication,
    );
  }

  private async createWithAllocation(
    params: WorktreeMutationGuard &
      Pick<CreateManagedWorktreeParams, "withSource" | "withRollback">,
    run: (
      guard: WorktreeAllocationGuard,
      publication: WorktreeCreationPublication,
    ) => Promise<ManagedWorktreeCreationOutcome>,
  ): Promise<ManagedWorktreeCreationOutcome> {
    const publication: WorktreeCreationPublication = {};
    try {
      return await this.withAllocationLease(params, (guard) => run(guard, publication));
    } catch (error) {
      const failures = [error];
      // Source unwind can fail after publication or restoration, before the caller receives the record.
      if (params.withSource && publication.record) {
        try {
          await this.rollbackPreparation(publication.record, params.withRollback);
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

  async rollbackPreparation(
    prepared: ManagedWorktreeRecord,
    withRollback?: CreateManagedWorktreeParams["withRollback"],
  ): Promise<void> {
    // Match creation's allocation → checkout order, without retaining a canceled caller.
    await this.withAllocationLease({}, async (allocation) => {
      const remove = async (assertCheckoutCurrent?: () => void) => {
        const commitGuard = () => {
          allocation.commitGuard?.();
          assertCheckoutCurrent?.();
        };
        commitGuard();
        const current = getRegistryWorktree(this.env, prepared.id);
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
    params: WorktreeMutationGuard,
    run: (guard: WorktreeAllocationGuard) => Promise<T>,
  ): Promise<T> {
    return await withWorktreeAllocationLease({ ...params, env: this.env }, run);
  }

  private requireAllocationSpace(target: string, repository: ResolvedRepository, bytes = 0) {
    requireWorktreeDiskSpace(
      [
        { path: target, bytes },
        { path: repository.commonDir, bytes: 0 },
        { path: repository.sourceRoot, bytes: 0 },
        { path: resolveStateDir(this.env), bytes: 0 },
      ],
      "worktree allocation",
    );
  }

  private async createForRepository(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
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
      ? findWorktreeByName(this.env, repository.fingerprint, suppliedName)
      : undefined;
    if (existing && params.profiles?.length) {
      throw new Error("Source profiles require a new worktree; choose an unused --name.");
    }
    // Name reuse only ever adopts the caller's own record. Without this guard a
    // caller-chosen name could bind a new owner to another session's or a
    // manual checkout and run inside it.
    if (existing && !existing.removedAt && !worktreeOwnerMatches(existing, params)) {
      throw new Error(
        `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${suppliedName}`,
      );
    }
    if (existing && existing.removedAt === undefined) {
      if (await worktreePathExists(existing.path)) {
        return await withWorktreeSource(params, async (current) => ({
          record: await this.rebindLiveRepository(existing, current),
          materialized: false,
        }));
      }
      await withWorktreeSource(params, () =>
        updateRegistryWorktree(this.env, existing.id, { removedAt: this.now() }),
      );
    }
    if (existing && existing.removedAt !== undefined && existing.snapshotRef) {
      if (!worktreeOwnerMatches(existing, params)) {
        throw new Error(
          `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${suppliedName}`,
        );
      }
      return await withWorktreeSource(params, async (current) => {
        const record = await this.restoreWithAllocation({
          id: existing.id,
          signal: current.signal,
          commitGuard: current.commitGuard,
          rollbackGuard: current.rollbackGuard,
        });
        publication.record = { ...record };
        return { record, materialized: true };
      });
    }
    let prepared: MaterializedRepositoryWorktree | undefined;
    let publicationStarted = false;
    try {
      const materialized = await withWorktreeSource(params, async (current) => {
        const created = await this.materializeRepositoryWorktree(
          current,
          repository,
          inferredName,
          suppliedName,
        );
        prepared = created;
        return created;
      });
      const provisionedPaths = await this.completeRepositoryWorktreeSetup(
        params,
        repository,
        materialized,
      );
      return await withWorktreeSource(params, (current) => {
        current.signal?.throwIfAborted();
        current.commitGuard?.();
        this.requireAllocationSpace(materialized.worktreePath, repository);
        // Preserve a possibly published record if insertion or source unwind fails.
        publicationStarted = true;
        const record = this.publishRepositoryWorktree(
          current,
          repository,
          materialized,
          provisionedPaths,
        );
        publication.record = { ...record };
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
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
    repository: ResolvedRepository,
    inferredName: string,
    suppliedName: string | undefined,
  ): Promise<MaterializedRepositoryWorktree> {
    const root = path.join(await this.worktreesRoot(), repository.fingerprint);
    const name =
      suppliedName ??
      (await generateName(
        this.env,
        repository.repoRoot,
        repository.fingerprint,
        root,
        params,
        params.suggestedName ?? inferredName,
      ));
    const worktreePath = path.join(root, name);
    const branch = `openclaw/${name}`;
    const branchExists = await runGit(repository.repoRoot, [
      "show-ref",
      "--quiet",
      "--verify",
      `refs/heads/${branch}`,
    ]);
    if (branchExists.code === 0) {
      throw new Error(`branch already exists: ${branch}`);
    }
    if (branchExists.code !== 1) {
      throw commandError("git show-ref --verify", branchExists);
    }
    // Default-base resolution fetches remote refs; it is an effect, not just discovery.
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    this.requireAllocationSpace(worktreePath, repository);
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
          gitBytes = await estimateWorktreeGitBytes(repository.repoRoot, commit, {
            signal: params.signal,
            assertCurrent: params.commitGuard,
          });
        },
        requireSpace: (cloneBytes) =>
          this.requireAllocationSpace(
            worktreePath,
            repository,
            (cloneBytes ?? 2 * gitBytes) + 2 * provisionedBytes + setupBytes,
          ),
        signal: params.signal,
        commitGuard: () => params.commitGuard?.(),
        rollbackGuard: params.rollbackGuard,
      });
    };
    let added = await addCheckout();
    if (added.code !== 0 && base.remote) {
      if (!(await canResetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, added))) {
        throw commandError("git worktree add", added);
      }
      await resetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, params.rollbackGuard);
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      gitBase = "HEAD";
      recordBase = "HEAD";
      added = await addCheckout();
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
        : await withWorktreeSource(params, (current) => {
            current.signal?.throwIfAborted();
            current.commitGuard?.();
            this.requireAllocationSpace(
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
      this.requireAllocationSpace(worktreePath, repository, setupBytes);
      await runSetupScript(repository.sourceRoot, worktreePath, params);
    }
    return provisionedPaths;
  }

  private publishRepositoryWorktree(
    params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
    repository: ResolvedRepository,
    materialized: MaterializedRepositoryWorktree,
    provisionedPaths: string[],
  ): ManagedWorktreeRecord {
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
      ownerKind: params.ownerKind ?? "manual",
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      createdAt,
      lastActiveAt: createdAt,
    };
    insertRegistryWorktree(this.env, record, { provisionedPaths });
    return record;
  }

  async list(): Promise<ManagedWorktreeRecord[]> {
    return await reconcileListedWorktrees(this.env, listRegistryWorktrees(this.env), this.now);
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
    const resolved = await resolveRepository(repoRoot);
    return {
      checkoutRoot: resolved.sourceRoot,
      repoRoot: resolved.repoRoot,
      originUrl: resolved.originUrl,
      fingerprint: resolved.fingerprint,
    };
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
    const record = this.requireLiveRecord(id);
    await lockWorktreeForProcess(record);
    const lastActiveAt = this.now();
    updateRegistryWorktree(this.env, id, { lastActiveAt });
    return { ...record, lastActiveAt };
  }

  async release(id: string): Promise<void> {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined || !(await worktreePathExists(record.path))) {
      return;
    }
    const state = await lockState(record);
    if (state.kind === "live" && state.pid !== process.pid) {
      return;
    }
    if (state.kind === "foreign") {
      return;
    }
    if (state.kind !== "none") {
      await unlockWorktree(record);
    }
  }

  async remove(input: RemoveWorktreeParams): Promise<RemoveManagedWorktreeResult> {
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
      const result = await this.withAllocationLease(params, async (guard) => {
        timing?.markPhase();
        try {
          await params.assertCleanupPressure?.();
          return await this.removeWithAllocation({ ...params, ...guard }, timing);
        } finally {
          timing?.markRemovalStage();
          timing?.markPhase();
        }
      });
      outcome = "returned";
      return result;
    } finally {
      timing?.finish(outcome);
    }
  }

  private async removeWithAllocation(
    params: RemoveWorktreeParams,
    timing: ReturnType<typeof startGitOperationTiming>,
  ): Promise<RemoveManagedWorktreeResult> {
    timing?.markRemovalStage("preparation");
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    const record = this.requireLiveRecord(params.id);
    if (params.exactState) {
      assertExactStateOwner(record, params.exactState);
      await requireWorktreeRemovalRef(
        record,
        { run: runGit },
        {
          signal: params.signal,
          beforeRun: params.commitGuard,
        },
      );
    }
    const claimToken = params.claimToken ?? randomUUID();
    claimWorktreeRemoval(this.env, { worktreeId: record.id, token: claimToken });
    try {
      const { withSettledLocalWorkspace } =
        await import("../../gateway/worker-environments/local-workspace-projection.js");
      return await withSettledLocalWorkspace(
        { worktree: record, env: this.env, assertCurrent: params.commitGuard, retireRuntime: true },
        (accepted) =>
          this.removeSettledWithAllocation(
            {
              ...params,
              claimToken,
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
      return rethrowWorktreeRemovalFailure(error, () =>
        abortWorktreeRemoval(this.env, record.id, claimToken),
      );
    }
  }

  private async removeSettledWithAllocation(
    input: RemoveWorktreeParams,
    timing: ReturnType<typeof startGitOperationTiming>,
    prepareArchive?: (snapshot: string) => Promise<void>,
  ): Promise<RemoveManagedWorktreeResult> {
    let params = input;
    timing?.markRemovalStage("preparation");
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    let record = this.requireLiveRecord(params.id);
    // Claim removal before any cleanliness or snapshot work so a live run lease
    // rejects it and an admitted run cannot start once the claim is held. The
    // opaque token makes the claim exclusive against competing removers; a caller
    // that already claimed (removeIfLossless) passes its token to keep one claim.
    const claimToken = params.claimToken!;
    const allocationGuard = params.commitGuard;
    let exactFinalized = false;
    if (params.exactState) {
      const expected = params.exactState;
      const original = record;
      params = {
        ...params,
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
          assertWorktreeRemovalClaim(this.env, original.id, claimToken);
        },
      };
    }
    record = await this.rebindLiveRepository(record, params);
    const gitOptions = {
      signal: params.signal,
      beforeRun: params.commitGuard,
      killProcessTree: true,
    };
    return await withManagedWorktreeGit(
      { record, env: this.env, getConfig: this.getConfig ?? getRuntimeConfig, ...gitOptions },
      async (git) => {
        const pendingRef = await requireWorktreeRemovalRef(record, git, gitOptions);
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
          });
          snapshotRef = snapshot.snapshotRef;
          exactStateDigest = snapshot.exactStateDigest;
          params.commitGuard?.();
          updateRegistryWorktree(this.env, record.id, {
            snapshotRef,
            provisionedState: snapshot.provisionedState,
          });
        } catch (error) {
          snapshotError = error instanceof Error ? error.message : String(error);
          try {
            clearRegistryWorktreeProvisionedChunks(this.env, record.id);
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
            abortWorktreeRemoval(this.env, record.id, claimToken);
            updateRegistryWorktree(
              this.env,
              record.id,
              {
                runEndCleanup: { outcome: "retained-dirty", at: this.now() },
              },
              { onlyIfLive: true, onlyIfActiveAt: record.lastActiveAt },
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
          params.commitGuard?.();
          if (deletionOptions) {
            await git.require(
              record.repoRoot,
              ["branch", "-d", "--", record.branch],
              deletionOptions,
            );
          }
          // Only prune the recorded checkout's empty parent; a changed allocation
          // root is neither required for removal nor authority to walk other parents.
          await fs.rmdir(path.dirname(record.path)).catch(() => undefined);
          params.commitGuard?.();
          const removedAt = this.now();
          // Persist the run-end outcome atomically with finalization: a post-finalize
          // write could race a restore plus newer cleanup and overwrite the newer fact.
          updateRegistryWorktree(
            this.env,
            record.id,
            {
              removedAt,
              snapshotRef,
              ...(params.runEndCleanup ? { runEndCleanup: params.runEndCleanup } : {}),
            },
            { assertCurrent: params.commitGuard },
          );
          exactFinalized = true;
          finalizeWorktreeRemoval(this.env, record.id);
          await git.require(
            record.repoRoot,
            ["update-ref", "-d", pendingRef, snapshot ?? head],
            gitOptions,
          );
          return {
            removed: true as const,
            ...(snapshotRef ? { snapshotRef } : {}),
            ...(snapshotError ? { snapshotError } : {}),
            ...(recoveryPath
              ? { recoveryPath, recoveryRetainedUntil: removedAt + SNAPSHOT_RETENTION_MS }
              : {}),
          };
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
        try {
          await removeManagedCheckout(record, git, params.requireLossless, params.commitGuard);
          return await finalize();
        } catch (error) {
          // Even a nonzero Git exit can follow partial or complete deletion.
          // Keep the pending snapshot and signal stale registry accounting.
          throw new WorktreeRemovalIncompleteError(error);
        }
      },
    );
  }

  async recoverRemoval(params: { id: string; snapshot: string } & WorktreeMutationGuard) {
    const { recoverManagedWorktreeRemoval } = await import("./removal-recovery.js");
    return await recoverManagedWorktreeRemoval(params, { env: this.env, now: this.now });
  }

  async restore(
    params: { id: string; recoverExactState?: ExactStateRetirement } & WorktreeMutationGuard,
  ): Promise<ManagedWorktreeRecord> {
    return await this.withAllocationLease(
      params,
      async (guard) => await this.restoreWithAllocation({ ...params, ...guard }),
    );
  }

  private async restoreWithAllocation(
    params: { id: string; recoverExactState?: ExactStateRetirement } & WorktreeAllocationGuard,
  ): Promise<ManagedWorktreeRecord> {
    return await restoreManagedWorktreeSnapshot(params, {
      env: this.env,
      now: this.now,
      getConfig: this.getConfig,
      requireSpace: (target, repository, bytes) =>
        this.requireAllocationSpace(target, repository, bytes),
    });
  }

  async removeIfLossless(id: string): Promise<boolean> {
    let record = this.requireLiveRecord(id);
    let inspectedHead: string;
    const claimToken = randomUUID();
    const recordOutcome = (outcome: ManagedWorktreeRunEndCleanupOutcome, error?: unknown) => {
      // Retained/failed writes happen after this remover released or aborted its
      // claim, so racing removers may have finalized the row, or removed AND
      // restored it into a new lifecycle. The live condition blocks the first;
      // conditioning on the activity stamp this remover observed blocks the
      // second (restore bumps lastActiveAt). The winning removal persists its
      // outcome atomically inside remove()'s finalization update, never here.
      updateRegistryWorktree(
        this.env,
        id,
        {
          runEndCleanup: {
            outcome,
            at: this.now(),
            ...(outcome === "failed"
              ? { reason: truncateUtf16Safe(formatErrorMessage(error), 500) }
              : {}),
          },
        },
        { onlyIfLive: true, onlyIfActiveAt: record.lastActiveAt },
      );
    };
    // Run-end cleanup must leave a durable outcome even when safety retains the checkout.
    // QA and operators observe this product-boundary fact through worktrees.list.
    try {
      claimWorktreeRemoval(this.env, { worktreeId: id, token: claimToken });
    } catch (error) {
      if (error instanceof WorktreeRemovalContentionError) {
        if (error.kind === "finalized") {
          // The winning remover owns the terminal cleanup fact; a late contender
          // must return without replacing it with a false retained/failed outcome.
          return false;
        }
        // A live run lease or a competing remover holds the worktree; a lossless
        // auto-cleanup must not race it.
        recordOutcome("retained-busy");
        return false;
      }
      try {
        recordOutcome("failed", error);
      } catch {
        // Preserve the claim failure when the same infrastructure blocks recording it.
      }
      throw error;
    }
    try {
      record = await this.rebindLiveRepository(record);
      inspectedHead = await requireManagedWorktreeHead(record, {});
      const inspection = await inspectManagedWorktreeCheckout(record, "lossless", {
        env: this.env,
        getConfig: this.getConfig ?? getRuntimeConfig,
      });
      const retainedOutcome =
        inspection.retainedReason === "nested-repository"
          ? "retained-dirty"
          : inspection.retainedReason === undefined
            ? undefined
            : (`retained-${inspection.retainedReason}` as const);
      if (retainedOutcome) {
        abortWorktreeRemoval(this.env, id, claimToken);
        recordOutcome(retainedOutcome);
        return false;
      }
    } catch (error) {
      abortWorktreeRemoval(this.env, id, claimToken);
      recordOutcome("failed", error);
      throw error;
    }
    try {
      await this.release(id);
      const result = await this.remove({
        id,
        reason: "run-end",
        claimToken,
        requireLossless: true,
        inspectedHead,
        runEndCleanup: { outcome: "removed-lossless", at: this.now() },
      });
      return result.removed;
    } catch (error) {
      abortWorktreeRemoval(this.env, id, claimToken);
      recordOutcome("failed", error);
      throw error;
    }
  }

  async removeIfLosslessByPath(
    worktreePath: string,
    owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  ): Promise<boolean> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (!record || !worktreeOwnerMatches(record, owner)) {
      return false;
    }
    return await this.removeIfLossless(record.id);
  }

  async releaseByPath(worktreePath: string): Promise<void> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (record) {
      await this.release(record.id);
    }
  }

  async gc(params: ManagedWorktreeGcParams = {}): Promise<ManagedWorktreeGcResult> {
    const now = this.now();
    const isLocked = createWorktreeLockPrefilter();
    const progress = new WorktreeGcProgress();
    const result = progress.result;
    const { records, leases } = await readWorktreeCleanupState(this.env);
    const liveLeaseScopes = new Set(leases.liveScopes);
    const observedIds = new Set(records.map((record) => record.id));
    const hasLiveLease = (id: string) =>
      observedIds.has(id)
        ? liveLeaseScopes.has(worktreeRunLeaseScope(id))
        : hasLiveWorktreeRunLease(this.env, id);
    const protect = (record: ManagedWorktreeRecord) =>
      autoRemovalProtectionReason(
        record,
        isLocked,
        hasLiveLease,
        { env: this.env, getConfig: this.getConfig ?? getRuntimeConfig },
        params.shouldProtectOwner,
      );
    for (const record of records) {
      try {
        if (record.removedAt === undefined && !(await worktreePathExists(record.path))) {
          retireMissingRegistryWorktree(this.env, record, now);
          continue;
        }
        // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
        const expiresWhenIdle = record.ownerKind === "workboard" || record.ownerKind === "session";
        if (record.removedAt !== undefined || !expiresWhenIdle) {
          continue;
        }
        const retiredOwner =
          record.ownerId !== undefined &&
          params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) === true;
        if (retiredOwner || now - record.lastActiveAt > IDLE_GC_MS) {
          // Each record gets one decision per pass. Limit enforcement consumes
          // this disposition instead of repeating a failed idle cleanup.
          if (!progress.start(record.id)) {
            continue;
          }
          const protection = await protect(record);
          if (protection !== undefined) {
            progress.protect("idle", record.id, protection);
            continue;
          }
          await this.remove({
            id: record.id,
            reason: retiredOwner ? "owner-gc" : "idle-gc",
            commitGuard: () => this.assertOwnerAllowsCleanup(record, params, retiredOwner),
          });
          result.removed.push(record.id);
        }
      } catch (error) {
        progress.error("idle", error, record.id);
        log.warn(`idle cleanup failed for ${record.id}: ${String(error)}`);
      }
    }
    try {
      // Empty caches must not wait behind checkout creation. Collection rereads
      // the templates under the lease before retiring any artifacts.
      if (hasTemplates(this.env)) {
        await this.withAllocationLease({}, async (guard) => {
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
      progress.error("templates", error);
      log.warn(`worktree template cleanup deferred: ${String(error)}`);
    }
    result.removed.push(
      ...(await enforceWorktreeCleanupLimits({
        env: this.env,
        limits: params.limits ?? resolveWorktreeCleanupLimits(),
        progress,
        protect,
        remove: async (record, assertCleanupPressure) => {
          await this.remove({
            id: record.id,
            reason: "limit-gc",
            assertCleanupPressure,
            commitGuard: () => this.assertOwnerAllowsCleanup(record, params),
          });
        },
      })),
    );
    let orphansDeleted = 0;
    let snapshotsPruned = 0;
    const expired = records.filter(
      (record) => record.removedAt !== undefined && now - record.removedAt > SNAPSHOT_RETENTION_MS,
    );
    const entries = await fs
      .readdir(path.join(resolveStateDir(this.env), "worktrees"), { withFileTypes: true })
      .catch(() => []);
    const hasOrphanCandidates = entries.some(
      (entry) => entry.isDirectory() && entry.name !== WORKTREE_TEMPLATE_DIRECTORY,
    );
    if (hasOrphanCandidates || expired.length > 0) {
      try {
        // Skip empty passes above; all destructive cleanup uses fresh facts under
        // the same lease as allocation and restore, including their partial paths.
        await this.withAllocationLease({}, async (guard) => {
          if (hasOrphanCandidates) {
            try {
              orphansDeleted = await this.reconcileOrphans(listRegistryWorktrees(this.env), guard);
            } catch (error) {
              progress.error("orphans", error);
              log.warn(`worktree orphan cleanup deferred: ${String(error)}`);
            }
          }
          for (const record of expired) {
            try {
              const current = getRegistryWorktree(this.env, record.id);
              if (
                !current ||
                current.removedAt === undefined ||
                now - current.removedAt <= SNAPSHOT_RETENTION_MS
              ) {
                continue;
              }
              await retireManagedWorktreeSnapshot({
                record: current,
                env: this.env,
                signal: guard.signal,
                assertCurrent: () => guard.commitGuard?.(),
              });
              snapshotsPruned += 1;
            } catch (error) {
              progress.error("snapshots", error, record.id);
              log.warn(`snapshot retention failed for ${record.id}: ${String(error)}`);
            }
          }
        });
      } catch (error) {
        progress.error("orphans", error);
        log.warn(`worktree cleanup deferred: ${String(error)}`);
      }
    }
    try {
      await reapWorktreeRunLeases(this.env, leases.staleScopes);
    } catch (error) {
      progress.error("idle", error);
    }
    result.orphansDeleted = orphansDeleted;
    result.snapshotsPruned = snapshotsPruned;
    return result;
  }

  private assertOwnerAllowsCleanup(
    record: ManagedWorktreeRecord,
    params: ManagedWorktreeGcParams,
    retiredOwner = false,
  ) {
    if (getRegistryWorktree(this.env, record.id)?.lastActiveAt !== record.lastActiveAt) {
      throw new WorktreeRemovalLockError("busy", "worktree activity changed during cleanup");
    }
    if (
      record.ownerId !== undefined &&
      (params.shouldProtectOwner?.(record.ownerKind, record.ownerId) === true ||
        (retiredOwner && params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) !== true))
    ) {
      throw new WorktreeRemovalLockError("busy", "worktree owner became active during cleanup");
    }
  }

  private requireLiveRecord(id: string): ManagedWorktreeRecord {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined) {
      throw new Error(`unknown active worktree: ${id}`);
    }
    return record;
  }

  private async rebindLiveRepository(
    record: ManagedWorktreeRecord,
    guard: WorktreeMutationGuard = {},
  ): Promise<ManagedWorktreeRecord> {
    const worktreePath = await fs.realpath(record.path);
    const repository = await resolveRepositoryFromRealPath(worktreePath, record.path);
    if (repository.sourceRoot !== worktreePath) {
      throw new WorktreeRepositoryError(`repository does not own worktree: ${record.path}`);
    }
    const registeredRepository = await resolveRepository(record.repoRoot);
    if (registeredRepository.originUrl !== repository.originUrl) {
      throw new WorktreeRepositoryError(`repository origin does not match: ${record.path}`);
    }
    guard.signal?.throwIfAborted();
    guard.commitGuard?.();
    updateRegistryWorktree(this.env, record.id, {
      repositoryIdentity: {
        repoRoot: repository.repoRoot,
        repoFingerprint: repository.fingerprint,
      },
    });
    return { ...record, repoRoot: repository.repoRoot, repoFingerprint: repository.fingerprint };
  }

  private async reconcileOrphans(
    records: ManagedWorktreeRecord[],
    guard: WorktreeMutationGuard,
  ): Promise<number> {
    const managedPaths = new Set<string>();
    for (const record of records) {
      try {
        managedPaths.add(await canonicalPathKey(record.path));
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
    // Only the default state-owned area grants orphan cleanup authority. A custom
    // root can contain unrelated directories; its cleanup is registry-bound above.
    const worktreesRoot = path.join(resolveStateDir(this.env), "worktrees");
    const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
    if (fingerprints.length === 0) {
      return 0;
    }
    const defaultRoot = await canonicalPathKey(worktreesRoot);
    const customRoots = new Set<string>();
    // Retain roots from recorded paths after configuration changes. Canonical
    // overlap protects nested roots and symlink aliases before recursive deletion.
    for (const root of [
      this.getConfig?.().worktreeRoot,
      ...records.map((record) => path.dirname(path.dirname(record.path))),
    ]) {
      if (!root) {
        continue;
      }
      try {
        const canonical = await canonicalPathKey(root);
        if (canonical !== defaultRoot) {
          customRoots.add(canonical);
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
    let deleted = 0;
    for (const fingerprint of fingerprints) {
      if (!fingerprint.isDirectory() || fingerprint.name === WORKTREE_TEMPLATE_DIRECTORY) {
        continue;
      }
      const fingerprintPath = path.join(worktreesRoot, fingerprint.name);
      // A root entry can be a checkout, not a fingerprint container; descending
      // before applying the same preservation rule would expose its contents to deletion.
      if (await shouldPreserveOrphanCandidate(fingerprintPath, managedPaths, customRoots)) {
        continue;
      }
      const names = await fs.readdir(fingerprintPath, { withFileTypes: true }).catch(() => []);
      for (const name of names) {
        if (!name.isDirectory()) {
          continue;
        }
        const candidate = path.join(fingerprintPath, name.name);
        if (await shouldPreserveOrphanCandidate(candidate, managedPaths, customRoots)) {
          continue;
        }
        guard.commitGuard?.();
        await fs.rm(candidate, { recursive: true, force: true });
        deleted += 1;
      }
      guard.commitGuard?.();
      await fs.rmdir(fingerprintPath).catch(() => undefined);
    }
    return deleted;
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
