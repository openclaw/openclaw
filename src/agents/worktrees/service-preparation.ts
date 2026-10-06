import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { createCommandError } from "../../process/command-error.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createCrustaceanSlug } from "../session-slug.js";
import {
  withWorktreeAllocationLease,
  waitForWorktreeCapacity,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import { WorktreeCapacityContentionError } from "./capacity.js";
import { WorktreeRepositoryError } from "./errors.js";
import {
  commandError,
  listGitWorktrees,
  worktreePathExists,
  requireGit,
  resolveGitRepositoryPaths,
  runGit,
  type GitResult,
} from "./git.js";
import { appendNameOrdinal, validateName } from "./name.js";
import { worktreeOwnerMatches } from "./owner.js";
import { startWorktreePreparationPhase } from "./preparation-timing.js";
import { readRegistryWorktrees, readLiveRegistryWorktreeByOwner } from "./registry-read.js";
import { updateRegistryWorktree } from "./registry.js";
import { resolveCheckoutRootFromRealPath } from "./repository-paths.js";
import { captureWorktreeRunEndContext, withWorktreeRunEnd } from "./run-end-lifecycle.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeCreationOutcome,
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "./types.js";

export async function prepareWorktreeDestination(params: {
  env: NodeJS.ProcessEnv;
  configuredRoot?: string;
  repository: ResolvedRepository;
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
    repository.repoRoot,
    repository.fingerprint,
    root,
    params.owner,
    params.suggestedName,
    params.suppliedName,
  );
  return { root, name, worktreePath: path.join(root, name), branch: `openclaw/${name}` };
}

export type WorktreeCreationPublication = {
  record?: ManagedWorktreeRecord;
  cleanup?: (assertCurrent: () => void) => Promise<void>;
};

export async function createWithWorktreeAllocation(
  params: Pick<
    CreateManagedWorktreeParams,
    "signal" | "commitGuard" | "withSource" | "withRollback"
  > & {
    env: NodeJS.ProcessEnv;
    workerAuthority?: WorktreeWorkerAuthority;
  },
  run: (
    guard: WorktreeAllocationGuard,
    publication: WorktreeCreationPublication,
  ) => Promise<ManagedWorktreeCreationOutcome>,
  rollbackPublished: (record: ManagedWorktreeRecord) => Promise<void>,
): Promise<ManagedWorktreeCreationOutcome> {
  for (;;) {
    const publication: WorktreeCreationPublication = {};
    try {
      const allocated = startWorktreePreparationPhase("allocate");
      try {
        return await withWorktreeAllocationLease(params, (guard) => {
          allocated();
          return run(guard, publication);
        });
      } finally {
        allocated();
      }
    } catch (error) {
      if (
        collectNestedErrorCandidates(error).some(
          (cause) => extractErrorCode(cause) === "outcome-unknown",
        )
      ) {
        // Uncertain native work retains its checkout, source custody, and byte reservations.
        throw error;
      }
      const failures = [error];
      if (publication.cleanup) {
        try {
          const cleanup = publication.cleanup;
          // The failed allocation and source have unwound; keep allocation → source lock order.
          await withWorktreeAllocationLease({ env: params.env }, async (allocation) => {
            const remove = async (assertCheckoutCurrent?: () => void) =>
              await cleanup(() => {
                allocation.commitGuard();
                assertCheckoutCurrent?.();
              });
            if (params.withRollback) {
              await params.withRollback(remove);
            } else {
              await remove();
            }
          });
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

/** Creation and restore retain sources while per-checkout retirement runs independently. */
export async function withWorktreeSources<T>(
  params: Pick<CreateManagedWorktreeParams, "signal" | "ownerKind" | "ownerId" | "name"> & {
    env: NodeJS.ProcessEnv;
    repository: ResolvedRepository;
    commitGuard: () => void;
    requiredPaths?: readonly string[];
    restoringId?: string;
  },
  run: (retainSources: WorktreeSourceCustody["retainSources"]) => Promise<T>,
): Promise<T> {
  const context = captureWorktreeRunEndContext(params.env);
  const held = new Map<string, Awaited<ReturnType<typeof acquireWorktreeRunLease>>>();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    // Restore already holds this checkout's mutation custody; incomplete recovery
    // must be able to take its removal claim without conflicting with itself.
    const records = (await readRegistryWorktrees(params.env, { liveOnly: true })).filter(
      (record) => record.id !== params.restoringId,
    );
    const { repository } = params;
    const requiredPaths = new Set([
      repository.sourceRoot,
      repository.repoRoot,
      repository.commonDir,
      ...(params.requiredPaths ?? []),
    ]);
    const reuseTargets = records.filter(
      (record) =>
        (params.ownerId && worktreeOwnerMatches(record, params)) ||
        (params.name === record.name && record.repoFingerprint === repository.fingerprint),
    );
    const retainSources = async (paths: readonly string[], initial = false) => {
      const previousSize = requiredPaths.size;
      for (const required of paths) {
        requiredPaths.add(required);
      }
      if (!initial && requiredPaths.size === previousSize) {
        return;
      }
      const source = await runGitWorkerOperation(
        {
          type: "worktree.eviction-source",
          input: {
            sourceRoot: repository.sourceRoot,
            commonDir: repository.commonDir,
            requiredPaths: [...requiredPaths],
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
      const needed = new Set([...source.worktreeIds, ...reuseTargets.map(({ id }) => id)]);
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
            env: params.env,
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
    await retainSources([], true);
    params.commitGuard();
    outcome = { ok: true, value: await run(retainSources) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (
    outcome.ok ||
    !collectNestedErrorCandidates(outcome.error).some(
      (cause) => extractErrorCode(cause) === "outcome-unknown",
    )
  ) {
    const released = await Promise.allSettled(
      [...held.values()].map(async (lease) => await lease.release()),
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

async function nameIsUnavailable(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fingerprint: string,
  root: string,
  name: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): Promise<boolean> {
  const worktreePath = path.join(root, name);
  const registered = await findWorktreeByName(env, fingerprint, name);
  if (
    owner.ownerId &&
    registered &&
    registered.removedAt === undefined &&
    worktreeOwnerMatches(registered, owner)
  ) {
    // Let createForRepository reuse the caller's live checkout; a collision here
    // could mint a second checkout for one owner. Removed records stay collisions:
    // restore is explicit-name/id only, so a generated name (title slug or random
    // crustacean) must never silently resurrect a retired checkout.
    return false;
  }
  if (registered || (await worktreePathExists(worktreePath))) {
    return true;
  }
  const branch = `openclaw/${name}`;
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    return true;
  }
  if (branchExists.code !== 1) {
    throw commandError("git show-ref --verify", branchExists);
  }
  return (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
}

async function resolveWorktreeName(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fingerprint: string,
  root: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  suggestedName: string,
  suppliedName?: string,
): Promise<string> {
  if (suppliedName !== undefined) {
    const branch = `openclaw/${suppliedName}`;
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
    return suppliedName;
  }
  validateName(suggestedName);
  for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
    const candidate = ordinal === 1 ? suggestedName : appendNameOrdinal(suggestedName, ordinal);
    if (!(await nameIsUnavailable(env, repoRoot, fingerprint, root, candidate, owner))) {
      return candidate;
    }
  }
  throw new Error(`no available worktree name for ${suggestedName}`);
}

export type ResolvedRepository = {
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
};

async function resolveRepositoryFromRealPath(
  requested: string,
  requestedLabel: string,
): Promise<ResolvedRepository> {
  const { root: sourceRoot } = await resolveCheckoutRootFromRealPath(requested, requestedLabel);
  const { canonicalRoot, commonDir } = await resolveGitRepositoryPaths(sourceRoot);
  const origin = await runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]);
  if (origin.termination !== "exit" || (origin.code !== 0 && origin.code !== 1)) {
    throw commandError("git config --get remote.origin.url", origin);
  }
  const originUrl = origin.code === 0 ? origin.stdout.trim() : "";
  const fingerprint = createHash("sha256")
    .update(`${commonDir}\n${originUrl}`)
    .digest("hex")
    .slice(0, 16);
  return { repoRoot: canonicalRoot, sourceRoot, commonDir, originUrl, fingerprint };
}

export async function resolveRepository(repoRoot: string): Promise<ResolvedRepository> {
  const requested = await fs.realpath(repoRoot).catch(() => {
    throw new Error(`repository does not exist: ${repoRoot}`);
  });
  return await resolveRepositoryFromRealPath(requested, repoRoot);
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
    await updateRegistryWorktree(
      env,
      record.id,
      {
        repositoryIdentity: {
          repoRoot: repository.repoRoot,
          repoFingerprint: repository.fingerprint,
        },
      },
      {
        workerAuthority: {
          ...guard.workerAuthority,
          assertCurrent: guard.workerAuthority?.assertCurrent ?? guard.commitGuard,
          predicates: [...(guard.workerAuthority?.predicates ?? []), { kind: "binding", record }],
        },
      },
    );
    guard.signal?.throwIfAborted();
    guard.commitGuard?.();
    return { ...record, repoRoot: repository.repoRoot, repoFingerprint: repository.fingerprint };
  });
}

export async function resolveRepositoryIdentity(repoRoot: string) {
  const resolved = await resolveRepository(repoRoot);
  return {
    checkoutRoot: resolved.sourceRoot,
    repoRoot: resolved.repoRoot,
    originUrl: resolved.originUrl,
    fingerprint: resolved.fingerprint,
  };
}

export async function cleanupFailedCreate(...args: Parameters<typeof removeFailedWorktree>) {
  const failure = await removeFailedWorktree(...args);
  if (failure) {
    throw new Error(`failed to clean up worktree creation: ${failure.message}`);
  }
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

export async function resetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  rollbackGuard: () => void,
): Promise<void> {
  const options = { beforeRun: rollbackGuard, killProcessTree: true };
  const listed = (await listGitWorktrees(repoRoot, options)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed) {
    const removed = await runGit(
      repoRoot,
      ["worktree", "remove", "--force", worktreePath],
      options,
    );
    if (removed.code !== 0) {
      throw commandError("git worktree remove", removed);
    }
  } else if (await worktreePathExists(worktreePath)) {
    // A failed add can leave an unregistered directory; it is safe debris once git omits it.
    rollbackGuard();
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  const branchExists = await runGit(
    repoRoot,
    ["show-ref", "--quiet", "--verify", `refs/heads/${branch}`],
    options,
  );
  if (branchExists.code === 0) {
    await requireGit(repoRoot, ["branch", "-D", branch], options);
  }
}

export async function canResetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  failure: GitResult,
): Promise<boolean> {
  // Keep retry evidence unchanged: diagnostic rendering/truncation must never
  // grant cleanup or retry authority.
  const message = (failure.stderr || failure.stdout).trim().split("\n").slice(-12).join("\n");
  const createdBranch = message.includes(`Preparing worktree (new branch '${branch}')`);
  if (message.includes("unable to checkout working tree") || createdBranch) {
    return true;
  }
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed || (await worktreePathExists(worktreePath))) {
    return false;
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  return branchExists.code === 1;
}

export async function runSetupScript(
  repoRoot: string,
  worktreePath: string,
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
): Promise<void> {
  const setupScript = path.join(repoRoot, ".openclaw", "worktree-setup.sh");
  const stat = await fs.stat(setupScript).catch(() => undefined);
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
    return;
  }
  const timeoutMs = 120_000;
  params.onProgress?.("setup");
  // Checkout may outlive its caller. Revalidate before starting repository code,
  // then retain process ownership through cancellation and rollback.
  const runInCallerContext = AsyncLocalStorage.snapshot();
  const cancellation = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, cancellation.signal])
    : cancellation.signal;
  let pending: ReturnType<typeof runCommandWithTimeout> | undefined;
  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    const operation = await withWorktreeSource(params, (current) => {
      current.signal?.throwIfAborted();
      current.commitGuard?.();
      // Spawn is synchronous; its continuation keeps the caller's original context.
      pending = runInCallerContext(() =>
        runCommandWithTimeout([setupScript], {
          timeoutMs,
          cwd: worktreePath,
          signal,
          killProcessTree: true,
          env: {
            OPENCLAW_SOURCE_TREE_PATH: repoRoot,
            OPENCLAW_WORKTREE_PATH: worktreePath,
          },
        }),
      );
      void pending.catch(() => undefined);
      return { completion: pending };
    });
    result = await operation.completion;
  } catch (error) {
    if (pending) {
      cancellation.abort(error);
      await pending.catch(() => undefined);
    }
    throw error;
  }
  params.signal?.throwIfAborted();
  if (result.code !== 0) {
    throw createCommandError("worktree setup", result, { timeoutMs });
  }
}

export async function createOwnedWorktree(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard & WorktreeSourceCustody,
  repository: ResolvedRepository,
  env: NodeJS.ProcessEnv,
  now: () => number,
  create: (name: string) => Promise<ManagedWorktreeCreationOutcome>,
): Promise<ManagedWorktreeCreationOutcome> {
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
