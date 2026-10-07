import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
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
  markTemplateReadyAsync,
  readTemplateAsync,
  reserveTemplateAsync,
  touchTemplateAsync,
} from "./template-registry-async.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

const log = createSubsystemLogger("agents/worktrees");
export const WORKTREE_TEMPLATE_DIRECTORY = ".templates";

/** Allocation custody covers preparation, cloning, replacement, and collection. */
async function retireWorktreeTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  assertCurrent();
  if (record.backend.startsWith("sandbox-")) {
    const { retireSandboxDependencyTemplate } = await import("../sandbox/dependency-template.js");
    await retireSandboxDependencyTemplate(record.path, assertCurrent);
  }
  const registered =
    (await worktreePathExists(record.repoRoot)) &&
    (await worktreePathExists(record.commonDir)) &&
    (
      await listGitWorktrees(record.repoRoot, { signal: options.signal, beforeRun: assertCurrent })
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
}

/** Called under the same allocation lease as checkout creation. */
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
      await retireWorktreeTemplate(env, record, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.commitGuard();
      onError?.(error, record.id);
      log.warn(`worktree template cleanup failed: ${String(error)}`);
    }
  }
}

/** Source and sandbox templates share the existing reservation and retention owner. */
export async function prepareWorktreeTemplate(params: {
  env: NodeJS.ProcessEnv;
  now: () => number;
  options: WorktreeFilesystemOptions;
  cacheKey: string;
  contentKey: string;
  repoRoot: string;
  commonDir: string;
  worktreeRoot: string;
  sourceCommit: string;
  backend: string;
  reuseOnly?: boolean;
  requireSpace: () => Promise<void>;
  validate: (record: WorktreeTemplateRecord) => Promise<boolean>;
  prepare: (record: WorktreeTemplateRecord) => Promise<void>;
}): Promise<WorktreeTemplateRecord | undefined> {
  const assertCurrent = () => {
    params.options.signal?.throwIfAborted();
    params.options.commitGuard();
  };
  const existing = await readTemplateAsync(params.env, params.cacheKey);
  assertCurrent();
  if (
    existing?.status === "ready" &&
    existing.contentKey === params.contentKey &&
    existing.backend === params.backend &&
    (await worktreePathExists(existing.path)) &&
    (await params.validate(existing))
  ) {
    setWorktreePreparationTemplate("warm");
    await touchTemplateAsync(params.env, existing.id, params.now(), assertCurrent);
    return existing;
  }
  if (params.reuseOnly) {
    return undefined;
  }
  setWorktreePreparationTemplate("cold");
  await params.requireSpace();
  if (existing) {
    await retireWorktreeTemplate(params.env, existing, params.options);
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
  assertCurrent();
  await fs.mkdir(directory, { recursive: true });
  await params.prepare(record);
  await markTemplateReadyAsync(params.env, id, params.now(), assertCurrent);
  return record;
}
