import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  withWorktreeMutationLease,
  startWorktreeWait,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import {
  listGitWorktrees,
  requireGit,
  worktreePathExists,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
} from "./git.js";
import {
  setWorktreePreparationTemplate,
  startWorktreePreparationPhase,
} from "./preparation-timing.js";
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
const pendingPreparations = new Map<string, Promise<void>>();

export async function retainWorktreeTemplate(
  env: NodeJS.ProcessEnv,
  selection:
    | WorktreeTemplateRecord
    | Pick<WorktreeTemplateRecord, "cacheKey" | "contentKey" | "backend">,
  assertCurrent: () => void,
  unpublish?: true,
): Promise<PreparedWorktreeTemplate | undefined> {
  const context = captureOpenClawStateWorkerContext({ env });
  const key = randomUUID();
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: getFileLockProcessStartTime(process.pid, env),
    processNamespace: readGatewayLockProcessNamespace(),
  };
  const release = async (outcome?: unknown) => {
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
  };
  try {
    const record = await retainTemplateReaderAsync(
      env,
      { key, owner, ...("id" in selection ? { id: selection.id, unpublish } : { selection }) },
      assertCurrent,
    );
    return record ? { ...record, release } : undefined;
  } catch (error) {
    await release(error);
    throw error;
  }
}

/** The cache key lease and retained readers jointly own template retirement. */
async function retireWorktreeTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord,
  options: WorktreeFilesystemOptions,
): Promise<boolean> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  const retained = await retainWorktreeTemplate(env, record, assertCurrent, true);
  if (!retained) {
    return false;
  }
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
    return true;
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
    const expiresBefore = record.cacheKey.startsWith("warm:")
      ? Math.max(before, Date.now() - 60 * 60_000)
      : before;
    if (record.status === "ready" && record.lastUsedAt >= expiresBefore) {
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
            (current.status === "ready" && current.lastUsedAt >= expiresBefore) ||
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
  refresh?: (record: WorktreeTemplateRecord, options: WorktreeAllocationGuard) => Promise<boolean>;
  prepare: (record: WorktreeTemplateRecord, options: WorktreeAllocationGuard) => Promise<void>;
}): Promise<PreparedWorktreeTemplate | undefined> {
  let retained: PreparedWorktreeTemplate | undefined;
  let preparationKey: string | undefined;
  let finishPreparation: (() => void) | undefined;
  try {
    const assertCallerCurrent = () => {
      params.options.signal?.throwIfAborted();
      params.options.commitGuard();
    };
    while (true) {
      retained = await retainWorktreeTemplate(
        params.env,
        { cacheKey: params.cacheKey, contentKey: params.contentKey, backend: params.backend },
        assertCallerCurrent,
      );
      if (retained) {
        setWorktreePreparationTemplate("warm", { reason: "ready" });
        return retained;
      }
      preparationKey ??= JSON.stringify([
        captureOpenClawStateWorkerContext({ env: params.env }).admission.coordinationKey,
        params.cacheKey,
      ]);
      const pending = pendingPreparations.get(preparationKey);
      if (!pending) {
        pendingPreparations.set(
          preparationKey,
          new Promise<void>((resolve) => {
            finishPreparation = resolve;
          }),
        );
        break;
      }
      // Wait for local publication, then acquire our own reader. Idle templates
      // still need validation; the persisted lease coordinates other processes.
      const waiting = startWorktreeWait(params.options.waitBudget);
      const finishWait = startWorktreePreparationPhase("mutationWait");
      const deadline = AbortSignal.timeout(waiting.waitMs);
      try {
        await racePromiseWithAbortSignal(
          pending,
          params.options.signal ? AbortSignal.any([params.options.signal, deadline]) : deadline,
        );
        assertCallerCurrent();
      } catch (error) {
        assertCallerCurrent();
        if (deadline.aborted) {
          const timeout = new OpenClawStateLeaseError(
            "managed worktree template preparation wait expired",
            {
              code: "OPENCLAW_STATE_LEASE_HELD",
              cause: error,
            },
          );
          waiting.end(timeout);
          throw timeout;
        }
        throw error;
      } finally {
        waiting.end();
        finishWait();
      }
    }
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
          existing.backend === params.backend &&
          (existing.contentKey === params.contentKey ||
            (params.refresh && !params.reuseOnly && !hasReaders))
        ) {
          // A ready generation with readers is immutable until they settle. Reuse
          // that admission instead of rescanning the same tree for every clone.
          retained = await retainWorktreeTemplate(
            params.env,
            existing,
            assertCurrent,
            hasReaders ? undefined : true,
          );
          if (!retained) {
            return undefined;
          }
          if (
            hasReaders ||
            ((await worktreePathExists(existing.path)) &&
              (await params.validate(existing, options)) &&
              (existing.contentKey === params.contentKey ||
                (await params.refresh?.(existing, options))))
          ) {
            setWorktreePreparationTemplate("warm", { reason: "ready" });
            if (!hasReaders) {
              await markTemplateReadyAsync(params.env, existing.id, params.now(), assertCurrent, {
                sourceCommit: params.sourceCommit,
                contentKey: params.contentKey,
              });
            }
            return {
              ...retained,
              status: "ready",
              sourceCommit: params.sourceCommit,
              contentKey: params.contentKey,
            };
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
        if (existing && !(await retireWorktreeTemplate(params.env, existing, options))) {
          return undefined;
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
        if (!retained) {
          throw new Error("Worktree template builder lost its reader custody");
        }
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
    if (
      params.options.signal?.aborted &&
      !(error instanceof OpenClawStateLeaseError) &&
      !hasWorktreeUnknownOutcome(error)
    ) {
      throw new OpenClawStateLeaseError("managed worktree template operation was aborted", {
        code: "OPENCLAW_STATE_LEASE_ABORTED",
        cause: error,
      });
    }
    throw error;
  } finally {
    if (finishPreparation && preparationKey) {
      pendingPreparations.delete(preparationKey);
      finishPreparation();
    }
  }
}
