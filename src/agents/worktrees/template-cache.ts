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
import { nativeWorktreeFilesystem } from "./filesystem-native.js";
import {
  listGitWorktrees,
  requireGit,
  worktreePathExists,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
} from "./git.js";
import {
  setWorktreePreparationTemplate,
  startWorktreePreparationPhase,
  timeWorktreePreparationPhase,
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
import {
  retainedWorktreeTemplateKey,
  worktreeTemplateMutationKey,
  type WorktreeTemplateRecord,
} from "./template-registry.js";

const log = createSubsystemLogger("agents/worktrees");
export const WORKTREE_TEMPLATE_DIRECTORY = ".templates";
const pendingPreparations = new Map<string, Promise<void>>();

export async function retainWorktreeTemplate(
  env: NodeJS.ProcessEnv,
  selection:
    | WorktreeTemplateRecord
    | (Pick<WorktreeTemplateRecord, "cacheKey" | "contentKey" | "backend"> & { now?: number }),
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
    // An interrupted clone may still carry the source generation's Git link.
    // Remove only our owned tree before Git retires its registered metadata.
    await nativeWorktreeFilesystem.remove(record.path, options);
    if (registered) {
      await requireGit(record.repoRoot, ["worktree", "remove", "--force", record.path], {
        signal: options.signal,
        beforeRun: assertCurrent,
        killProcessTree: true,
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      });
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
  options: WorktreeFilesystemOptions & {
    beforeRemoval?: () => Promise<void>;
    maxRemovals?: number;
    scope?: Pick<WorktreeTemplateRecord, "commonDir" | "worktreeRoot">;
  },
  onError?: (error: unknown, id: string) => void,
): Promise<void> {
  const records = (await listTemplatesAsync(env)).filter(
    (record) =>
      !options.scope ||
      (record.commonDir === options.scope.commonDir &&
        record.worktreeRoot === options.scope.worktreeRoot),
  );
  const retained = new Set<string>();
  const groups = new Map<string, { count: number; currentKey: string }>();
  // Bound across runtime identities, so a changed image/store cannot add another allowance.
  for (const record of records.toReversed()) {
    if (record.status !== "ready" || !record.backend.startsWith("sandbox-")) {
      continue;
    }
    const group = JSON.stringify([record.commonDir, record.worktreeRoot]);
    const selection = groups.get(group) ?? {
      count: 0,
      currentKey: worktreeTemplateMutationKey(record.cacheKey),
    };
    groups.set(group, selection);
    if (++selection.count <= 4) {
      retained.add(record.id);
    }
  }
  let removed = 0;
  for (const record of records) {
    const sandbox = record.backend.startsWith("sandbox-");
    const overCapacity = sandbox && record.status === "ready" && !retained.has(record.id);
    const supersededIdentity =
      sandbox &&
      groups.get(JSON.stringify([record.commonDir, record.worktreeRoot]))?.currentKey !==
        worktreeTemplateMutationKey(record.cacheKey);
    const expiresBefore = supersededIdentity
      ? Math.max(before, Date.now() - 6 * 60 * 60_000)
      : record.cacheKey.startsWith("warm:")
        ? Math.max(before, Date.now() - 60 * 60_000)
        : before;
    if (record.status === "ready" && record.lastUsedAt >= expiresBefore && !overCapacity) {
      continue;
    }
    try {
      // Wait for maintenance IO capacity without blocking this identity's foreground readers.
      await options.beforeRemoval?.();
      await withWorktreeMutationLease(
        { env, ...options, id: `template:${worktreeTemplateMutationKey(record.cacheKey)}` },
        async (guard) => {
          const current = await readTemplateAsync(env, record.cacheKey, guard.commitGuard);
          if (
            !current ||
            current.id !== record.id ||
            (current.status === "ready" &&
              current.lastUsedAt >= expiresBefore &&
              (!overCapacity || current.lastUsedAt !== record.lastUsedAt))
          ) {
            return;
          }
          if (await retireWorktreeTemplate(env, current, guard)) {
            removed++;
          }
        },
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      options.commitGuard();
      onError?.(error, record.id);
      log.warn(`worktree template cleanup failed: ${String(error)}`);
    }
    if (options.maxRemovals !== undefined && removed >= options.maxRemovals) {
      break;
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
  backgroundUsedAt?: number;
  requireSpace: () => Promise<void>;
  /** Immutable generations consume producer validation; mutable templates revalidate on reuse. */
  validate?: (
    record: WorktreeTemplateRecord,
    options: WorktreeFilesystemOptions,
  ) => Promise<boolean>;
  refresh?: (
    existing: WorktreeTemplateRecord,
    preparing: WorktreeTemplateRecord,
    options: WorktreeAllocationGuard,
  ) => Promise<boolean>;
  prepare: (record: WorktreeTemplateRecord, options: WorktreeAllocationGuard) => Promise<void>;
}): Promise<PreparedWorktreeTemplate | undefined> {
  const { validate } = params;
  const retainCommits = params.backend.startsWith("sandbox-");
  let built = false;
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
        {
          cacheKey: params.cacheKey,
          contentKey: params.contentKey,
          backend: params.backend,
          now: retainCommits ? (params.backgroundUsedAt ?? params.now()) : undefined,
        },
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
    const result = await withWorktreeMutationLease(
      { env: params.env, ...params.options, id: `template:${params.cacheKey}` },
      async (options) => {
        const assertCurrent = options.commitGuard;
        const existing = await readTemplateAsync(
          params.env,
          params.cacheKey,
          assertCurrent,
          retainCommits ? params.contentKey : undefined,
        );
        assertCurrent();
        const hasReaders = existing
          ? await hasTemplateReadersAsync(params.env, existing.id, assertCurrent)
          : false;
        let refreshable = false;
        if (
          existing?.status === "ready" &&
          existing.backend === params.backend &&
          (existing.contentKey === params.contentKey ||
            (params.refresh && !params.reuseOnly && (!hasReaders || retainCommits)))
        ) {
          // Idle validation is read-only and owned by the selection lease. Publishing
          // no reader until it succeeds keeps fast readers behind that validation.
          let valid = hasReaders;
          try {
            valid ||=
              (await worktreePathExists(existing.path)) &&
              (!validate ||
                (await timeWorktreePreparationPhase("templateValidate", () =>
                  validate(existing, options),
                )));
          } catch (error) {
            if (hasWorktreeUnknownOutcome(error)) {
              retained = await retainWorktreeTemplate(
                params.env,
                existing,
                options.rollbackGuard,
                true,
              );
            }
            throw error;
          }
          if (valid && existing.contentKey === params.contentKey) {
            retained = await retainWorktreeTemplate(params.env, existing, assertCurrent);
            const usedAt = params.backgroundUsedAt ?? params.now();
            if (!hasReaders && usedAt > existing.lastUsedAt) {
              await markTemplateReadyAsync(params.env, existing.id, usedAt, assertCurrent);
            }
            setWorktreePreparationTemplate("warm", { reason: "ready" });
            return retained;
          }
          refreshable = valid;
        }
        if (params.reuseOnly || (hasReaders && (!retainCommits || existing?.status !== "ready"))) {
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
        // Preserve the observed miss after build progress replaces reason with ready.
        setWorktreePreparationTemplate("cold", {
          reason: "template-disk-admission",
          missReason: !existing
            ? "no-generation"
            : existing.status !== "ready"
              ? "invalid"
              : existing.backend !== params.backend
                ? "backend-changed"
                : existing.sourceCommit !== params.sourceCommit
                  ? "commit-changed"
                  : existing.contentKey !== params.contentKey
                    ? "content-changed"
                    : "invalid",
          priorSourceCommit: existing?.sourceCommit.slice(0, 12),
          requestedSourceCommit: params.sourceCommit.slice(0, 12),
        });
        await params.requireSpace();
        const id = randomUUID();
        const directory = path.join(params.worktreeRoot, WORKTREE_TEMPLATE_DIRECTORY);
        const record: WorktreeTemplateRecord & { status: "preparing" } = {
          cacheKey: existing ? `preparing:${id}` : params.cacheKey,
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
          lastUsedAt: Math.max(params.backgroundUsedAt ?? params.now(), existing?.lastUsedAt ?? 0),
        };
        await reserveTemplateAsync(params.env, record, assertCurrent);
        built = true;
        retained = await retainWorktreeTemplate(params.env, record, assertCurrent);
        if (!retained) {
          throw new Error("Worktree template builder lost its reader custody");
        }
        assertCurrent();
        await fs.mkdir(directory, { recursive: true });
        setWorktreePreparationTemplate("cold", { reason: "template-build" });
        let refreshed = false;
        if (refreshable && existing && params.refresh) {
          const source = await retainWorktreeTemplate(params.env, existing, assertCurrent);
          if (!source) {
            throw new Error("Worktree template refresh lost its source custody");
          }
          let outcome: unknown;
          try {
            refreshed = await params.refresh(existing, record, options);
          } catch (error) {
            outcome = error;
            throw error;
          } finally {
            await source.release(outcome);
          }
        }
        if (!refreshed) {
          await params.prepare(record, options);
        }
        const cacheKey =
          existing?.contentKey === params.contentKey ? existing.cacheKey : params.cacheKey;
        await markTemplateReadyAsync(
          params.env,
          id,
          params.backgroundUsedAt === undefined ? params.now() : record.lastUsedAt,
          assertCurrent,
          {
            cacheKey,
            previousId: existing?.id,
            retainedCacheKey:
              retainCommits && refreshable && existing && existing.contentKey !== params.contentKey
                ? retainedWorktreeTemplateKey(params.cacheKey, existing.contentKey)
                : undefined,
          },
        );
        setWorktreePreparationTemplate(refreshed ? "warm" : "cold", { reason: "ready" });
        return { ...retained, cacheKey, status: "ready" as const };
      },
    );
    if (built && retainCommits) {
      await collectWorktreeTemplates(params.env, 0, {
        ...params.options,
        maxRemovals: 1,
        scope: { commonDir: params.commonDir, worktreeRoot: params.worktreeRoot },
      });
    }
    return result;
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
