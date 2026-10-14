import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import { createCrustaceanSlug } from "../session-slug.js";
import {
  withWorktreeAllocationLease,
  withWorktreeMutationLease,
  waitForWorktreeCapacity,
  WORKTREE_CREATE_LEASE_WAIT_MS,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import { WorktreeCapacityContentionError } from "./capacity.js";
import {
  hasWorktreeUnknownOutcome,
  WorktreePendingContentionError,
  WorktreeRepositoryError,
} from "./errors.js";
import { indexWorktreePaths } from "./gc-dependencies.js";
import { commandError, listGitWorktrees, worktreePathExists, requireGit, runGit } from "./git.js";
import { appendNameOrdinal, validateName } from "./name.js";
import { assertOwnerWorktreeReuse, worktreeOwnerMatches } from "./owner.js";
import { readPendingWorktrees, releasePendingWorktree } from "./pending-slots.js";
import {
  startWorktreePreparationPhase,
  timeWorktreePreparationPhase,
} from "./preparation-timing.js";
import {
  prepareWorktreeRegistryGuard,
  readRegistryWorktrees,
  readLiveRegistryWorktreeByOwner,
} from "./registry-read.js";
import { updateRegistryWorktree } from "./registry.js";
import {
  resolveRepository,
  resolveRepositoryFromRealPath,
  type ResolvedRepository,
} from "./repository-paths.js";
import { captureWorktreeRunEndContext, withWorktreeRunEnd } from "./run-end-lifecycle.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeCreationOutcome,
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
  WorktreeCreationPublication,
} from "./types.js";

export async function readWorktreeGitInventory(repoRoot: string, suppliedName?: string) {
  const [branches, worktrees] = await Promise.all([
    requireGit(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/openclaw/"]),
    suppliedName === undefined ? listGitWorktrees(repoRoot) : [],
  ]);
  return {
    branches: new Set(branches.split("\n")),
    paths: new Set(worktrees.map((entry) => path.resolve(entry.path))),
  };
}

export async function prepareWorktreeDestination(params: {
  env: NodeJS.ProcessEnv;
  configuredRoot?: string;
  repository: ResolvedRepository;
  gitInventory: Awaited<ReturnType<typeof readWorktreeGitInventory>>;
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">;
  suppliedName?: string;
  suggestedName: string;
}) {
  const { env, repository } = params;
  const configuredRoot = params.configuredRoot ?? path.join(resolveStateDir(env), "worktrees");
  await fs.mkdir(configuredRoot, { recursive: true });
  // Git canonicalizes checkout paths; creation and lock/adoption comparisons must agree.
  const root = path.join(await fs.realpath(configuredRoot), repository.fingerprint);
  const name = await resolveWorktreeName(
    env,
    params.gitInventory,
    repository.fingerprint,
    root,
    params.owner,
    params.suggestedName,
    params.suppliedName,
  );
  return { root, name, worktreePath: path.join(root, name), branch: `openclaw/${name}` };
}

export async function createWithWorktreeAllocation(
  input: Pick<CreateManagedWorktreeParams, "signal" | "commitGuard" | "withSource"> & {
    env: NodeJS.ProcessEnv;
    workerAuthority?: WorktreeWorkerAuthority;
  },
  run: (
    guard: WorktreeAllocationGuard,
    publication: WorktreeCreationPublication,
  ) => Promise<ManagedWorktreeCreationOutcome>,
  rollbackPublished: (record: ManagedWorktreeRecord) => Promise<void>,
): Promise<ManagedWorktreeCreationOutcome> {
  const params = {
    ...input,
    waitBudget: { remainingMs: WORKTREE_CREATE_LEASE_WAIT_MS },
  };
  for (;;) {
    const publication: WorktreeCreationPublication = { id: randomUUID() };
    try {
      const allocated = startWorktreePreparationPhase("allocate");
      try {
        return await withWorktreeMutationLease({ ...params, id: publication.id }, async (guard) => {
          allocated();
          try {
            return await run(guard, publication);
          } catch (error) {
            if (
              !hasWorktreeUnknownOutcome(error) &&
              !(
                error instanceof OpenClawStateLeaseError &&
                error.code === "OPENCLAW_STATE_LEASE_LOST"
              ) &&
              publication.pending &&
              !(await worktreePathExists(publication.pending.path))
            ) {
              try {
                // Caller cancellation cannot retire checkout custody before its slot rollback.
                await releasePendingWorktree(params.env, publication.id, {
                  leaseSet: guard.workerAuthority.leaseSet,
                });
                publication.pending = undefined;
              } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "Worktree slot rollback failed", {
                  cause: cleanupError,
                });
              }
            }
            throw error;
          }
        });
      } finally {
        allocated();
      }
    } catch (error) {
      if (hasWorktreeUnknownOutcome(error)) {
        // Uncertain native work retains its checkout, source custody, and byte reservations.
        throw error;
      }
      const failures = [error];
      if (publication.pending) {
        try {
          await withWorktreeAllocationLease(
            { env: params.env, id: publication.id },
            async (allocation) => {
              if (publication.pending && !(await worktreePathExists(publication.pending.path))) {
                await releasePendingWorktree(
                  params.env,
                  publication.id,
                  allocation.workerAuthority,
                );
              }
            },
          );
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      // Source unwind can fail after publication or restoration, before the caller receives the record.
      if (params.withSource && publication.record) {
        try {
          await rollbackPublished(publication.record);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, failures.map(String).join("\n"), { cause: error });
      }
      if (error instanceof WorktreePendingContentionError && !publication.record) {
        await withWorktreeMutationLease({ ...params, id: error.worktreeId }, async () => {});
        // The creator can die during the wait. Release checkout custody before allocation recovery.
        await withWorktreeAllocationLease(params, async () => {
          const pending = (await readPendingWorktrees(params.env)).find(
            ({ record, state }) => record.id === error.worktreeId && state === "pending",
          );
          if (pending) {
            await requireNewWorktreeBranch(pending.record.repoRoot, pending.record.branch);
            throw new Error(
              "Worktree creation did not settle; run openclaw worktrees gc to recover its pending slot",
              { cause: error },
            );
          }
        });
        continue;
      }
      if (error instanceof WorktreeCapacityContentionError && !publication.record) {
        await waitForWorktreeCapacity(error, params);
        continue;
      }
      throw error;
    }
  }
}

export type WorktreeSourceCustody = {
  retainSources: (requiredPaths: readonly string[]) => Promise<void>;
};

type WorktreeSourceRepository = Pick<
  CreateManagedWorktreeParams,
  "signal" | "ownerKind" | "ownerId" | "name"
> & {
  repository: ResolvedRepository;
  commitGuard: () => void;
  requiredPaths?: readonly string[];
  restoringId?: string;
};

/** Source custody can begin inside allocation and outlive its short reservation interval. */
export async function withWorktreeSources<T>(
  env: NodeJS.ProcessEnv,
  run: (
    retainRepository: (
      params: WorktreeSourceRepository,
    ) => Promise<WorktreeSourceCustody["retainSources"]>,
  ) => Promise<T>,
): Promise<T> {
  const context = captureWorktreeRunEndContext(env);
  const held = new Map<string, Awaited<ReturnType<typeof acquireWorktreeRunLease>>>();
  const retainRepository = async (params: WorktreeSourceRepository) =>
    timeWorktreePreparationPhase("sources", async () => {
      // Restore already holds this checkout's mutation custody; incomplete recovery
      // must be able to take its removal claim without conflicting with itself.
      const records = (await readRegistryWorktrees(env, { liveOnly: true })).filter(
        (record) => record.id !== params.restoringId,
      );
      const { repository } = params;
      const source = await runGitWorkerOperation(
        {
          type: "worktree.eviction-source",
          input: {
            sourceRoot: repository.sourceRoot,
            commonDir: repository.commonDir,
            requiredPaths: [repository.repoRoot, ...(params.requiredPaths ?? [])],
            records: records.map(({ id, path: checkoutPath, repoRoot }) => ({
              id,
              path: checkoutPath,
              repoRoot,
            })),
          },
        },
        { signal: params.signal, assertCurrent: params.commitGuard },
      );
      if (!source.complete) {
        throw new Error(
          "Managed worktree source Git storage cannot be inspected safely. Repair its Git metadata before retrying.",
        );
      }
      const ancestors = indexWorktreePaths(source.ownedPaths);
      const reuseTargets = records.filter(
        (record) =>
          (params.ownerId && worktreeOwnerMatches(record, params)) ||
          (params.name === record.name && record.repoFingerprint === repository.fingerprint),
      );
      const retainSources = async (paths: readonly string[]) => {
        // Additional destinations share this custody scope's prepared ownership inventory.
        // Native removal still rechecks dependencies before deleting a checkout.
        const needed = new Set([
          ...source.worktreeIds,
          ...reuseTargets.map(({ id }) => id),
          ...paths.flatMap((required) => [...ancestors(required)]),
        ]);
        for (const record of records) {
          if (!needed.has(record.id) || held.has(record.id)) {
            continue;
          }
          params.commitGuard();
          const missing = !(await worktreePathExists(record.path));
          params.commitGuard();
          held.set(
            record.id,
            await acquireWorktreeRunLease(record.id, {
              env,
              source: { context, record },
              ...(missing ? { allowMissingCheckout: true } : {}),
            }),
          );
          if (held.size % 8 === 0) {
            await yieldTurn();
          }
        }
        params.commitGuard();
      };
      await retainSources([]);
      params.commitGuard();
      return retainSources;
    });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run(retainRepository) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (outcome.ok || !hasWorktreeUnknownOutcome(outcome.error)) {
    const released = await timeWorktreePreparationPhase("sourceRelease", () =>
      Promise.allSettled([...held.values()].map(async (lease) => await lease.release())),
    );
    const cleanupErrors = released.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [...(outcome.ok ? [] : [outcome.error]), ...cleanupErrors],
        "Worktree source custody could not settle",
      );
    }
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

export async function withWorktreeSource<T>(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
  run: (current: CreateManagedWorktreeParams & WorktreeAllocationGuard) => T | Promise<T>,
): Promise<T> {
  const { withSource, ...operation } = params;
  params.commitGuard?.();
  if (!withSource) {
    return await run(operation);
  }
  return await withSource((source) => {
    const commitGuard = () => {
      params.commitGuard?.();
      source.assertCurrent();
    };
    commitGuard();
    const signal =
      params.signal && source.signal
        ? AbortSignal.any([params.signal, source.signal])
        : (source.signal ?? params.signal);
    const rollbackGuard = () => {
      params.rollbackGuard();
      source.assertCheckoutCurrent?.();
    };
    const workerAuthority = {
      ...params.workerAuthority,
      assertCurrent: () => {
        signal?.throwIfAborted();
        (params.workerAuthority ? params.workerAuthority.assertCurrent : params.commitGuard)?.();
        (source.workerAuthority ? source.workerAuthority.assertCurrent : source.assertCurrent)?.();
      },
      predicates: [
        ...(params.workerAuthority?.predicates ?? []),
        ...(source.workerAuthority?.predicates ?? []),
      ],
    };
    return run({ ...operation, signal, commitGuard, rollbackGuard, workerAuthority });
  });
}

export async function findWorktreeByName(
  env: NodeJS.ProcessEnv,
  fingerprint: string,
  name: string,
) {
  return (await readRegistryWorktrees(env)).find(
    (record) => record.repoFingerprint === fingerprint && record.name === name,
  );
}

async function resolveWorktreeName(
  env: NodeJS.ProcessEnv,
  gitInventory: Awaited<ReturnType<typeof readWorktreeGitInventory>>,
  fingerprint: string,
  root: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  suggestedName: string,
  suppliedName?: string,
): Promise<string> {
  if (suppliedName !== undefined) {
    if (gitInventory.branches.has(`refs/heads/openclaw/${suppliedName}`)) {
      throw new Error(`branch already exists: openclaw/${suppliedName}`);
    }
    return suppliedName;
  }
  validateName(suggestedName);
  for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
    const candidate = ordinal === 1 ? suggestedName : appendNameOrdinal(suggestedName, ordinal);
    const worktreePath = path.join(root, candidate);
    const registered = await findWorktreeByName(env, fingerprint, candidate);
    // Reuse the caller's live checkout, but never resurrect a retired inferred name.
    if (
      owner.ownerId &&
      registered &&
      registered.removedAt === undefined &&
      worktreeOwnerMatches(registered, owner)
    ) {
      return candidate;
    }
    // External Git can change after discovery; native creation owns the final check.
    if (
      !registered &&
      !(await readPendingWorktrees(env)).some(
        ({ record }) => record.repoFingerprint === fingerprint && record.name === candidate,
      ) &&
      !(await worktreePathExists(worktreePath)) &&
      !gitInventory.branches.has(`refs/heads/openclaw/${candidate}`) &&
      !gitInventory.paths.has(path.resolve(worktreePath))
    ) {
      return candidate;
    }
  }
  throw new Error(`no available worktree name for ${suggestedName}`);
}

async function requireNewWorktreeBranch(repoRoot: string, branch: string): Promise<void> {
  const existing = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (existing.code === 0) {
    throw new Error(`branch already exists: ${branch}`);
  }
  if (existing.code !== 1) {
    throw commandError("git show-ref --verify", existing);
  }
}

/** Rebind a live checkout only after its canonical repository and recorded origin agree. */
export async function rebindLiveWorktreeRepository(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  guard: Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
    workerAuthority?: WorktreeWorkerAuthority;
  } = {},
): Promise<ManagedWorktreeRecord> {
  return withWorktreeRunEnd(env, async () => {
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
    const authority = {
      ...guard.workerAuthority,
      assertCurrent: guard.workerAuthority?.assertCurrent ?? guard.commitGuard,
      predicates: [
        ...(guard.workerAuthority?.predicates ?? []),
        { kind: "binding" as const, record },
      ],
    };
    if (
      record.repoRoot === repository.repoRoot &&
      record.repoFingerprint === repository.fingerprint
    ) {
      await prepareWorktreeRegistryGuard(captureWorktreeRunEndContext(env), authority);
      guard.signal?.throwIfAborted();
      return record;
    }
    const rebind = (workerAuthority: WorktreeWorkerAuthority) =>
      updateRegistryWorktree(
        env,
        record.id,
        {
          repositoryIdentity: {
            repoRoot: repository.repoRoot,
            repoFingerprint: repository.fingerprint,
          },
        },
        { workerAuthority },
      );
    if (authority.leaseSet?.mutationWorktreeIds?.includes(record.id)) {
      await rebind(authority);
    } else {
      await withWorktreeMutationLease(
        { env, id: record.id, ...guard, workerAuthority: authority },
        (held) => rebind(held.workerAuthority),
      );
    }
    guard.signal?.throwIfAborted();
    guard.commitGuard?.();
    return { ...record, repoRoot: repository.repoRoot, repoFingerprint: repository.fingerprint };
  });
}

export async function removeFailedWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string | undefined,
  rollbackGuard: () => void,
): Promise<Error | undefined> {
  const options = { beforeRun: rollbackGuard, killProcessTree: true };
  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath], options);
  const deletedBranch = branch
    ? await runGit(repoRoot, ["branch", "-D", branch], options)
    : undefined;
  if (removed.code !== 0) {
    return commandError("git worktree remove", removed);
  }
  if (deletedBranch && deletedBranch.code !== 0) {
    return commandError("git branch -D", deletedBranch);
  }
  return undefined;
}

export async function createOwnedWorktree<T>(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
  repository: ResolvedRepository,
  env: NodeJS.ProcessEnv,
  now: () => number,
  create: (name: string) => Promise<T>,
): Promise<ManagedWorktreeCreationOutcome | T> {
  if (params.ownerId) {
    const existing = await readLiveRegistryWorktreeByOwner(
      captureWorktreeRunEndContext(env),
      params.ownerKind ?? "manual",
      params.ownerId,
    );
    if (existing && params.profiles?.length) {
      throw new Error("Source profiles require a new worktree; use a new owner and name.");
    }
    if (existing && (await worktreePathExists(existing.path))) {
      return await withWorktreeSource(params, async (current) => {
        const validated = await rebindLiveWorktreeRepository(env, existing, current);
        assertOwnerWorktreeReuse(validated, current, repository.repoRoot);
        current.commitGuard?.();
        return { record: validated, materialized: false };
      });
    }
    if (existing) {
      await withWorktreeSource(params, async (current) => {
        current.commitGuard?.();
        await updateRegistryWorktree(
          env,
          existing.id,
          { removedAt: now() },
          {
            workerAuthority: {
              ...current.workerAuthority,
              predicates: [
                ...(current.workerAuthority.predicates ?? []),
                { kind: "binding", record: existing },
              ],
            },
          },
        );
      });
    }
  }
  return await create(params.name ?? params.suggestedName ?? createCrustaceanSlug());
}
