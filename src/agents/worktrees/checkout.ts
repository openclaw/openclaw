import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  detectWorktreeFilesystemBackend,
  type WorktreeFilesystemOptions,
} from "./filesystem-backend.js";
import {
  listGitWorktrees,
  worktreePathExists,
  requireGit,
  runGit,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
  type GitResult,
} from "./git.js";
import {
  deleteTemplate,
  listTemplates,
  markTemplateReady,
  readTemplate,
  reserveTemplate,
  touchTemplate,
  type WorktreeTemplateRecord,
} from "./template-registry.js";

const log = createSubsystemLogger("agents/worktrees");
export const WORKTREE_TEMPLATE_DIRECTORY = ".templates";

type CheckoutOptions = WorktreeFilesystemOptions & {
  env: NodeJS.ProcessEnv;
  now: () => number;
  enabled: boolean;
  repoRoot: string;
  commonDir: string;
  worktreeRoot: string;
  destination: string;
  base: string;
  branch?: string;
};

function assertOwned(options: WorktreeFilesystemOptions) {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function indexPath(worktree: string): Promise<string> {
  return path.resolve(
    worktree,
    normalizeGitPathForFilesystem(await requireGit(worktree, ["rev-parse", "--git-path", "index"])),
  );
}

// Path-dependent filters and per-worktree configuration need a fresh checkout.
// Hash all effective configuration so checkout policy changes retire the cache.
async function checkoutKey(options: CheckoutOptions, commit: string): Promise<string | undefined> {
  if (
    [
      "GIT_INDEX_FILE",
      "GIT_WORK_TREE",
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_ATTR_SOURCE",
    ].some((key) => process.env[key])
  ) {
    return undefined;
  }
  const config = await requireGit(options.repoRoot, ["config", "--null", "--list"], {
    signal: options.signal,
  });
  for (const field of config.split("\0")) {
    const key = field.split("\n", 1)[0]?.toLowerCase() ?? "";
    if (
      /^(filter\.|includeif\.|core\.(attributesfile|worktree|sparsecheckout|splitindex)$|extensions\.worktreeconfig$|index\.sparse$)/u.test(
        key,
      )
    ) {
      return undefined;
    }
  }
  // Outside-tree attributes can select transforms that depend on the checkout path.
  // Leave those repositories with Git until a backend models that contract.
  if (await worktreePathExists(path.join(options.commonDir, "info", "attributes"))) {
    return undefined;
  }
  for (const variable of ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"]) {
    const result = await runGit(options.repoRoot, ["var", variable], { signal: options.signal });
    // Older Git cannot report its attribute search paths: retain native checkout.
    if (
      result.code !== 0 ||
      (result.stdout.trim() &&
        (await worktreePathExists(normalizeGitPathForFilesystem(result.stdout.trim()))))
    ) {
      return undefined;
    }
  }
  return digest(`source-v1\n${commit}\n${config}`);
}

async function retireTemplate(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  const registered =
    (await worktreePathExists(record.repoRoot)) &&
    (await worktreePathExists(record.commonDir)) &&
    (await listGitWorktrees(record.repoRoot, { signal: options.signal })).some(
      (entry) => path.resolve(entry.path) === record.path,
    );
  assertOwned(options);
  if (registered) {
    await requireGit(record.repoRoot, ["worktree", "remove", "--force", record.path], {
      signal: options.signal,
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    });
  } else {
    // The reserved UUID path, including incomplete preparations, belongs to this row.
    await fs.rm(record.path, { recursive: true, force: true });
  }
  assertOwned(options);
  deleteTemplate(env, record.id, options.commitGuard);
}

/** Called under the same allocation lease as checkout creation. */
export async function collectWorktreeTemplates(
  env: NodeJS.ProcessEnv,
  before: number,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  for (const record of listTemplates(env)) {
    if (record.status === "ready" && record.lastUsedAt >= before) {
      continue;
    }
    try {
      await retireTemplate(env, record, options);
    } catch (error) {
      assertOwned(options);
      log.warn(`worktree template cleanup failed: ${String(error)}`);
    }
  }
}

async function prepareTemplate(options: CheckoutOptions) {
  const backend = await detectWorktreeFilesystemBackend(path.dirname(options.destination), options);
  if (!backend) {
    return undefined;
  }
  const commit = await requireGit(
    options.repoRoot,
    ["rev-parse", "--verify", `${options.base}^{commit}`],
    { signal: options.signal },
  );
  const contentKey = await checkoutKey(options, commit);
  if (!contentKey) {
    return undefined;
  }
  const cacheKey = digest(`${options.commonDir}\n${options.worktreeRoot}`);
  const existing = readTemplate(options.env, cacheKey);
  if (
    existing?.status === "ready" &&
    existing.contentKey === contentKey &&
    existing.backend === backend.id
  ) {
    const status = await runGit(
      existing.path,
      ["status", "--porcelain", "--untracked-files=all", "--ignored"],
      { signal: options.signal },
    );
    const head =
      status.code === 0
        ? await requireGit(existing.path, ["rev-parse", "HEAD"], { signal: options.signal })
        : undefined;
    if (status.code === 0 && !status.stdout && head === commit) {
      assertOwned(options);
      touchTemplate(options.env, existing.id, options.now(), options.commitGuard);
      return { record: existing, backend };
    }
  }
  if (existing) {
    await retireTemplate(options.env, existing, options);
  }
  const id = randomUUID();
  const directory = path.join(options.worktreeRoot, WORKTREE_TEMPLATE_DIRECTORY);
  const record: WorktreeTemplateRecord & { status: "preparing" } = {
    cacheKey,
    id,
    repoRoot: options.repoRoot,
    commonDir: options.commonDir,
    worktreeRoot: options.worktreeRoot,
    path: path.join(directory, id),
    backend: backend.id,
    sourceCommit: commit,
    contentKey,
    status: "preparing",
    createdAt: options.now(),
    lastUsedAt: options.now(),
  };
  assertOwned(options);
  reserveTemplate(options.env, record, options.commitGuard);
  assertOwned(options);
  await fs.mkdir(directory, { recursive: true });
  await backend.createTemplate(record.path, options);
  assertOwned(options);
  await requireGit(options.repoRoot, ["worktree", "add", "--detach", "--", record.path, commit], {
    signal: options.signal,
    timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
  });
  assertOwned(options);
  markTemplateReady(options.env, id, options.now(), options.commitGuard);
  return { record, backend };
}

/** Git owns registration, branches and indexes; the backend only materializes files. */
export async function addManagedWorktree(options: CheckoutOptions): Promise<GitResult> {
  let template: Awaited<ReturnType<typeof prepareTemplate>>;
  if (options.enabled) {
    try {
      template = await prepareTemplate(options);
    } catch (error) {
      assertOwned(options);
      log.warn(`worktree acceleration unavailable; using Git checkout: ${String(error)}`);
    }
  }
  assertOwned(options);
  const added = await runGit(
    options.repoRoot,
    [
      "worktree",
      "add",
      ...(template ? ["--no-checkout"] : []),
      ...(options.branch ? ["-b", options.branch] : ["--detach"]),
      "--",
      options.destination,
      options.base,
    ],
    { signal: options.signal, timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
  );
  if (added.code !== 0 || !template) {
    return added;
  }
  const markerPath = path.join(options.destination, ".git");
  let marker: Buffer | undefined;
  try {
    marker = await fs.readFile(markerPath);
    const destinationIndex = await indexPath(options.destination);
    const head = await requireGit(options.destination, ["rev-parse", "HEAD"], {
      signal: options.signal,
    });
    if (head !== template.record.sourceCommit) {
      throw new Error("worktree base moved during template preparation");
    }
    assertOwned(options);
    await fs.unlink(markerPath);
    assertOwned(options);
    await fs.rmdir(options.destination);
    await template.backend.cloneTemplate(template.record.path, options.destination, options);
    assertOwned(options);
    await fs.writeFile(markerPath, marker);
    const sourceIndex = await indexPath(template.record.path);
    assertOwned(options);
    await fs.copyFile(sourceIndex, destinationIndex, constants.COPYFILE_FICLONE);
    // Snapshot backends preserve file identity. Git validates its own cached stat
    // data; a future backend with different inode semantics still remains correct.
    assertOwned(options);
    await requireGit(options.destination, ["update-index", "--refresh"], {
      signal: options.signal,
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    });
    return added;
  } catch (error) {
    // A stale allocator cannot roll back a checkout after lease takeover.
    // Preserve Git's registration for recovery if authority was revoked.
    assertOwned(options);
    if (marker) {
      await fs.rm(options.destination, { recursive: true, force: true });
      assertOwned(options);
      await fs.mkdir(options.destination);
      assertOwned(options);
      await fs.writeFile(markerPath, marker);
    }
    assertOwned(options);
    log.warn(`worktree snapshot failed; using Git checkout: ${String(error)}`);
    const checkout = await runGit(options.destination, ["reset", "--hard", "HEAD"], {
      signal: options.signal,
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    });
    if (checkout.code !== 0) {
      assertOwned(options);
      await requireGit(options.repoRoot, ["worktree", "remove", "--force", options.destination], {
        signal: options.signal,
      });
      if (options.branch) {
        assertOwned(options);
        await requireGit(options.repoRoot, ["branch", "-D", options.branch], {
          signal: options.signal,
        });
      }
    }
    return checkout.code === 0 ? added : checkout;
  }
}
