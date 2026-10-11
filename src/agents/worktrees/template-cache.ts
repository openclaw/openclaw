import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withWorktreeMutationLease, type WorktreeAllocationGuard } from "./allocation.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import {
  listGitWorktrees,
  requireGit,
  worktreePathExists,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
} from "./git.js";
import { setWorktreePreparationTemplate } from "./preparation-timing.js";
import {
  deleteTemplateAsync,
  listTemplatesAsync,
  hasTemplateReadersAsync,
  retainTemplateReaderAsync,
  releaseTemplateReaderAsync,
  markTemplateReadyAsync,
  readTemplateAsync,
  reserveTemplateAsync,
} from "./template-registry-async.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

const log = createSubsystemLogger("agents/worktrees");
export const WORKTREE_TEMPLATE_DIRECTORY = ".templates";

async function retainWorktreeTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord,
  assertCurrent: () => void,
  unpublish?: true,
): Promise<PreparedWorktreeTemplate> {
  const context = captureOpenClawStateWorkerContext({ env });
  const key = randomUUID();
  const retained: PreparedWorktreeTemplate = {
    ...record,
    release: async (outcome) => {
      if (!hasWorktreeUnknownOutcome(outcome)) {
        try {
          await releaseTemplateReaderAsync(env, key, () => context.admission.assertCurrent());
        } catch (cleanupError) {
          if (outcome !== undefined) {
            throw new AggregateError(
              [outcome, cleanupError],
              "Worktree template operation and reader release failed",
              { cause: cleanupError },
            );
          }
          throw cleanupError;
        }
      }
    },
  };
  try {
    await retainTemplateReaderAsync(
      env,
      {
        id: record.id,
        unpublish,
        key,
        owner: {
          pid: process.pid,
          host: hostname(),
          startedAt: getFileLockProcessStartTime(process.pid, env),
          processNamespace: readGatewayLockProcessNamespace(),
        },
      },
      assertCurrent,
    );
    return retained;
  } catch (error) {
    await retained.release(error);
    throw error;
  }
}

/** The cache key lease and retained readers jointly own template retirement. */
async function retireWorktreeTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  const retained = await retainWorktreeTemplate(env, record, assertCurrent, true);
  let outcome: unknown;
  try {
    assertCurrent();
    if (record.backend.startsWith("sandbox-")) {
      const { retireSandboxDependencyTemplate } = await import("../sandbox/dependency-template.js");
      await retireSandboxDependencyTemplate(record.path, assertCurrent);
    }
    const registered =
      (await worktreePathExists(record.repoRoot)) &&
      (await worktreePathExists(record.commonDir)) &&
      (
        await listGitWorktrees(record.repoRoot, {
          signal: options.signal,
          beforeRun: assertCurrent,
        })
      ).some((entry) => path.resolve(entry.path) === record.path);
    assertCurrent();
    if (registered) {
      await requireGit(record.repoRoot, ["worktree", "remove", "--force", record.path], {
        signal: options.signal,
        beforeRun: assertCurrent,
        killProcessTree: true,
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      });
    } else {
      await fs.rm(record.path, { recursive: true, force: true });
    }
    await deleteTemplateAsync(env, record.id, assertCurrent);
  } catch (error) {
    outcome = error;
    throw error;
  } finally {
    await retained.release(outcome);
  }
}

/** Collection rechecks each generation after acquiring its template custody. */
export async function collectWorktreeTemplates(
  env: NodeJS.ProcessEnv,
  before: number,
  options: WorktreeFilesystemOptions,
  onError?: (error: unknown, id: string) => void,
): Promise<void> {
  for (const record of await listTemplatesAsync(env)) {
    if (record.status === "ready" && record.lastUsedAt >= before) {
      continue;
    }
    try {
      await withWorktreeMutationLease(
        { env, ...options, id: `template:${record.cacheKey}` },
        async (guard) => {
          const current = await readTemplateAsync(env, record.cacheKey, guard.commitGuard);
          if (
            !current ||
            current.id !== record.id ||
            (current.status === "ready" && current.lastUsedAt >= before) ||
            (await hasTemplateReadersAsync(env, current.id, guard.commitGuard))
          ) {
            return;
          }
          await retireWorktreeTemplate(env, current, guard);
        },
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      options.commitGuard();
      onError?.(error, record.id);
      log.warn(`worktree template cleanup failed: ${String(error)}`);
    }
  }
}

export type PreparedWorktreeTemplate = WorktreeTemplateRecord & {
  release: (outcome?: unknown) => Promise<void>;
};

/** Source and sandbox templates share persisted build and reader custody. */
export async function prepareWorktreeTemplate(params: {
  env: NodeJS.ProcessEnv;
  now: () => number;
  options: WorktreeFilesystemOptions & Pick<WorktreeAllocationGuard, "waitBudget">;
  cacheKey: string;
  contentKey: string;
  repoRoot: string;
  commonDir: string;
  worktreeRoot: string;
  sourceCommit: string;
  backend: string;
  reuseOnly?: boolean;
  requireSpace: () => Promise<void>;
  validate: (
    record: WorktreeTemplateRecord,
    options: WorktreeFilesystemOptions,
  ) => Promise<boolean>;
  prepare: (record: WorktreeTemplateRecord, options: WorktreeAllocationGuard) => Promise<void>;
}): Promise<PreparedWorktreeTemplate | undefined> {
  let retained: PreparedWorktreeTemplate | undefined;
  try {
    return await withWorktreeMutationLease(
      { env: params.env, ...params.options, id: `template:${params.cacheKey}` },
      async (options) => {
        const assertCurrent = options.commitGuard;
        const existing = await readTemplateAsync(params.env, params.cacheKey);
        assertCurrent();
        const hasReaders = existing
          ? await hasTemplateReadersAsync(params.env, existing.id, assertCurrent)
          : false;
        if (
          existing?.status === "ready" &&
          existing.contentKey === params.contentKey &&
          existing.backend === params.backend
        ) {
          retained = await retainWorktreeTemplate(params.env, existing, assertCurrent, true);
          if (
            (await worktreePathExists(existing.path)) &&
            (await params.validate(existing, options))
          ) {
            setWorktreePreparationTemplate("warm", { reason: "ready" });
            await markTemplateReadyAsync(params.env, existing.id, params.now(), assertCurrent);
            return retained;
          }
          await retained.release();
          retained = undefined;
        }
        if (params.reuseOnly || hasReaders) {
          setWorktreePreparationTemplate("unavailable", {
            reason: hasReaders
              ? existing?.status === "preparing"
                ? "template-building"
                : "stale-template-in-use"
              : existing
                ? "template-stale"
                : "template-missing",
          });
          return undefined;
        }
        setWorktreePreparationTemplate("cold", { reason: "template-disk-admission" });
        await params.requireSpace();
        if (existing) {
          await retireWorktreeTemplate(params.env, existing, options);
        }
        const id = randomUUID();
        const directory = path.join(params.worktreeRoot, WORKTREE_TEMPLATE_DIRECTORY);
        const record: WorktreeTemplateRecord & { status: "preparing" } = {
          cacheKey: params.cacheKey,
          id,
          repoRoot: params.repoRoot,
          commonDir: params.commonDir,
          worktreeRoot: params.worktreeRoot,
          path: path.join(directory, id),
          backend: params.backend,
          sourceCommit: params.sourceCommit,
          contentKey: params.contentKey,
          status: "preparing",
          createdAt: params.now(),
          lastUsedAt: params.now(),
        };
        await reserveTemplateAsync(params.env, record, assertCurrent);
        retained = await retainWorktreeTemplate(params.env, record, assertCurrent);
        assertCurrent();
        await fs.mkdir(directory, { recursive: true });
        setWorktreePreparationTemplate("cold", { reason: "template-build" });
        await params.prepare(record, options);
        await markTemplateReadyAsync(params.env, id, params.now(), assertCurrent);
        setWorktreePreparationTemplate("cold", { reason: "ready" });
        return { ...retained, status: "ready" };
      },
    );
  } catch (error) {
    await retained?.release(error);
    throw error;
  }
}
