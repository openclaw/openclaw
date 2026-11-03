import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { createCommandError } from "../../process/command-error.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { logWorktreeBase, resolveWorktreeCreationBase } from "./base-ref.js";
import {
  directorySizeBytes,
  estimateWorktreeGitBytes,
  requireAllocationSpace,
  WORKTREE_SETUP_HEADROOM_BYTES,
} from "./capacity.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { resolveWorktreeCheckoutKey } from "./checkout-policy-key.js";
import { selectWarmWorktree, isWarmWorktreeClean } from "./checkout-pool.js";
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import { addManagedWorktree } from "./checkout.js";
import { commandError, worktreePathExists } from "./git.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";
import { provisionIncludedFiles } from "./provisioned-files.js";
import type { ResolvedRepository } from "./repository-paths.js";
import {
  withWorktreeSource,
  type RepositoryCreationParams,
  type prepareWorktreeDestination,
} from "./service-preparation.js";
import { prepareWorktreeTemplate } from "./template-cache.js";
import { readTemplateAsync } from "./template-registry-async.js";
import type { WorktreeWarmPoolRequest } from "./template-registry.js";
import type { CreateManagedWorktreeParams } from "./types.js";

export type MaterializedRepositoryWorktree = {
  worktreePath: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};

export async function completeRepositoryWorktreeSetup(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
  env: NodeJS.ProcessEnv,
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
            env,
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
    await requireAllocationSpace(params, env, worktreePath, repository, setupBytes);
    await timeWorktreePreparationPhase("setup", () =>
      runSetupScript(repository.sourceRoot, worktreePath, params),
    );
  }
  return provisionedPaths;
}

async function runSetupScript(
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

export async function materializeRepositoryWorktree(
  params: Omit<RepositoryCreationParams, "gitInventory">,
  env: NodeJS.ProcessEnv,
  repository: ResolvedRepository,
  destination: Awaited<ReturnType<typeof prepareWorktreeDestination>>,
  worktreeId: string,
  accelerationEnabled: () => boolean,
): Promise<MaterializedRepositoryWorktree & { warmPool?: WorktreeWarmPoolRequest }> {
  const { root, worktreePath, branch } = destination;
  // Default-base resolution fetches remote refs; it is an effect, not just discovery.
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  await requireAllocationSpace(params, env, worktreePath, repository);
  params.commitGuard?.();
  const base = await timeWorktreePreparationPhase("base", () =>
    resolveWorktreeCreationBase(repository.repoRoot, params),
  );
  params.onProgress?.("checkout");
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
  const onPromptReady =
    params.onPromptReady &&
    !runRepositorySetup &&
    !(await worktreePathExists(path.join(repository.sourceRoot, ".worktreeinclude")))
      ? params.onPromptReady
      : undefined;
  const setupBytes = runRepositorySetup
    ? Math.max(
        WORKTREE_SETUP_HEADROOM_BYTES,
        await directorySizeBytes(repository.sourceRoot, {
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
      env,
      now: Date.now,
      waitBudget: params.waitBudget,
      enabled: accelerationEnabled(),
      repoRoot: repository.repoRoot,
      commonDir: repository.commonDir,
      worktreeRoot: path.dirname(root),
      destination: worktreePath,
      sourceOnly: params.provisionIgnoredFiles === false,
      branch,
      base: sourceProfile?.commit ?? gitBase,
      sourceProfile,
      ...(onPromptReady
        ? {
            onPromptReady: async (commit: string) =>
              onPromptReady({
                id: worktreeId,
                path: worktreePath,
                branch,
                repoRoot: repository.repoRoot,
                commit,
              }),
          }
        : {}),
      prepareCommit: async (commit) => {
        const guard = { signal: params.signal, assertCurrent: params.commitGuard };
        await logWorktreeBase(repository.repoRoot, base, commit, {
          worktreePath,
          ownerId: params.ownerId,
          now: Date.now(),
          ...guard,
        });
        return (gitBytes = await estimateWorktreeGitBytes(repository.repoRoot, commit, {
          ...guard,
          preparationKey: base.preparationKey,
        }));
      },
      requireSpace: (cloneBytes) =>
        requireAllocationSpace(
          params,
          env,
          worktreePath,
          repository,
          (cloneBytes ?? 2 * gitBytes) + 2 * provisionedBytes + setupBytes,
        ),
      signal: params.signal,
      commitGuard: () => params.commitGuard?.(),
      rollbackGuard: params.rollbackGuard,
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
    warmPool: added.warmPool,
  };
}

export async function prepareWarmWorktree(
  env: NodeJS.ProcessEnv,
  request: WorktreeWarmPoolRequest,
  guard: WorktreeAllocationGuard,
  requireSpace: (bytes?: number) => Promise<void>,
): Promise<void> {
  const { template, sourceOnly } = request;
  const current = await readTemplateAsync(env, template.cacheKey, guard.commitGuard);
  if (current?.id !== template.id || current.contentKey !== template.contentKey) {
    return;
  }
  const prepared = await prepareWorktreeTemplate({
    ...template,
    ...selectWarmWorktree(template),
    env,
    now: Date.now,
    options: guard,
    requireSpace: () => requireSpace(request.cloneBytes),
    validate: (record, options) =>
      isWarmWorktreeClean(record, options, sourceOnly, template.contentKey),
    prepare: async (record, options) => {
      const result = await addManagedWorktree({
        ...options,
        env,
        now: Date.now,
        enabled: true,
        repoRoot: template.repoRoot,
        commonDir: template.commonDir,
        worktreeRoot: template.worktreeRoot,
        destination: record.path,
        base: template.sourceCommit,
        sourceOnly,
        useWarmPool: false,
        requireSpace,
      });
      if (result.code !== 0) {
        throw new Error("Warm worktree preparation failed");
      }
      const gitOptions = {
        signal: options.signal,
        beforeRun: options.commitGuard,
        killProcessTree: true,
      };
      const contentKey = await withWorktreeGitConfig(record.path, sourceOnly, gitOptions, (git) =>
        resolveWorktreeCheckoutKey({
          destination: record.path,
          commonDir: template.commonDir,
          commit: template.sourceCommit,
          gitOptions,
          git,
        }),
      );
      if (contentKey !== template.contentKey) {
        throw new Error("Warm worktree checkout policy changed during preparation");
      }
    },
  });
  await prepared?.release();
}
