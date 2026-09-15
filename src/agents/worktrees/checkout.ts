import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
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
  /** Restore reuses a warm template, or materializes its snapshot after registration. */
  deferGitCheckout?: boolean;
  requireSpace: (cloneBytes?: number) => void;
};

type CheckoutResult = GitResult & { templateCloned?: true };

function assertOwned(options: WorktreeFilesystemOptions) {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

function gitOptions(options: WorktreeFilesystemOptions) {
  return {
    signal: options.signal,
    beforeRun: () => assertOwned(options),
    killProcessTree: true,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function indexPath(worktree: string, options: WorktreeFilesystemOptions): Promise<string> {
  return path.resolve(
    worktree,
    normalizeGitPathForFilesystem(
      await requireGit(worktree, ["rev-parse", "--git-path", "index"], gitOptions(options)),
    ),
  );
}

async function estimateTemplateCloneBytes(
  template: NonNullable<Awaited<ReturnType<typeof prepareTemplate>>>,
): Promise<number | undefined> {
  const index = await fs.open(template.sourceIndex, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await index.read(header, 0, header.length, 0);
    const { size } = await index.stat();
    const version = header.readUInt32BE(4);
    const entries = header.readUInt32BE(8);
    // Git already validated the template. Unsupported or incomplete index headers
    // cannot justify reduced admission; retain the full checkout allowance.
    if (
      bytesRead !== 12 ||
      header.toString("ascii", 0, 4) !== "DIRC" ||
      version < 2 ||
      version > 4 ||
      entries > Math.floor((size - 12) / 62)
    ) {
      return undefined;
    }
    return template.backend.estimateCloneBytes(entries, size);
  } finally {
    await index.close();
  }
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
  const config = await requireGit(
    options.repoRoot,
    ["config", "--null", "--list"],
    gitOptions(options),
  );
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
  // Join both probes before returning or throwing, including cancellation, so
  // checkout cleanup cannot race an admitted Git process.
  const attributePaths = await Promise.allSettled(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map((variable) =>
      runGit(options.repoRoot, ["var", variable], gitOptions(options)),
    ),
  );
  for (const probe of attributePaths) {
    if (probe.status === "rejected") {
      throw probe.reason;
    }
    const result = probe.value;
    // git var exits 1 without output for a known but disabled path (for example
    // GIT_ATTR_NOSYSTEM=1). Unknown variables on older Git still report an error.
    if (
      result.termination === "exit" &&
      result.code === 1 &&
      !result.stdout.trim() &&
      !result.stderr.trim()
    ) {
      continue;
    }
    // Older Git cannot report its attribute search paths: retain native checkout.
    if (
      result.termination !== "exit" ||
      result.code !== 0 ||
      result.stdoutTruncatedBytes ||
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
    (await listGitWorktrees(record.repoRoot, gitOptions(options))).some(
      (entry) => path.resolve(entry.path) === record.path,
    );
  assertOwned(options);
  if (registered) {
    await requireGit(record.repoRoot, ["worktree", "remove", "--force", record.path], {
      ...gitOptions(options),
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
  onRetireError: (error: unknown) => void,
): Promise<void> {
  for (const record of listTemplates(env)) {
    if (record.status === "ready" && record.lastUsedAt >= before) {
      continue;
    }
    try {
      await retireTemplate(env, record, options);
    } catch (error) {
      assertOwned(options);
      onRetireError(error);
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
    gitOptions(options),
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
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored"],
      gitOptions(options),
    );
    // Porcelain v2 reports HEAD with the inventory. NUL records keep newlines
    // in filenames from impersonating headers; every non-header means dirty.
    const fields = status.stdout.split("\0");
    const heads = fields.filter((field) => field.startsWith("# branch.oid "));
    if (
      status.termination === "exit" &&
      status.code === 0 &&
      !status.stdoutTruncatedBytes &&
      fields.pop() === "" &&
      fields.every((field) => field.startsWith("# ")) &&
      heads.length === 1 &&
      heads[0] === `# branch.oid ${commit}`
    ) {
      assertOwned(options);
      touchTemplate(options.env, existing.id, options.now(), options.commitGuard);
      return { record: existing, backend, sourceIndex: await indexPath(existing.path, options) };
    }
  }
  // Restore must not build an obsolete parent tree just to overwrite it with its snapshot.
  if (options.deferGitCheckout) {
    return undefined;
  }
  options.requireSpace();
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
  options.requireSpace();
  await backend.createTemplate(record.path, options);
  assertOwned(options);
  await requireGit(options.repoRoot, ["worktree", "add", "--detach", "--", record.path, commit], {
    ...gitOptions(options),
    beforeRun: () => {
      assertOwned(options);
      options.requireSpace();
    },
    timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
  });
  assertOwned(options);
  markTemplateReady(options.env, id, options.now(), options.commitGuard);
  return { record, backend, sourceIndex: await indexPath(record.path, options) };
}

/** Git owns registration, branches and indexes; the backend only materializes files. */
export async function addManagedWorktree(options: CheckoutOptions): Promise<CheckoutResult> {
  let template: Awaited<ReturnType<typeof prepareTemplate>>;
  let cloneBytes: number | undefined;
  if (options.enabled) {
    try {
      template = await prepareTemplate(options);
      cloneBytes = template ? await estimateTemplateCloneBytes(template) : undefined;
    } catch (error) {
      assertOwned(options);
      template = undefined;
      log.warn(`worktree acceleration unavailable; using Git checkout: ${String(error)}`);
    }
  }
  assertOwned(options);
  try {
    options.requireSpace(cloneBytes);
  } catch (error) {
    if (!template) {
      throw error;
    }
    // Tiny source trees can cost less than the conservative clone metadata allowance.
    // Select Git before registration only when its full checkout budget fits.
    options.requireSpace();
    template = undefined;
    cloneBytes = undefined;
  }
  const added = await runGit(
    options.repoRoot,
    [
      "worktree",
      "add",
      ...(template || options.deferGitCheckout ? ["--no-checkout"] : []),
      ...(options.branch ? ["-b", options.branch] : ["--detach"]),
      "--",
      options.destination,
      options.base,
    ],
    {
      ...gitOptions(options),
      beforeRun: () => {
        assertOwned(options);
        options.requireSpace(cloneBytes);
      },
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    },
  );
  if (added.code !== 0 || !template) {
    return added;
  }
  const markerPath = path.join(options.destination, ".git");
  let marker: Buffer | undefined;
  try {
    marker = await fs.readFile(markerPath);
    const metadata = await requireGit(
      options.destination,
      ["rev-parse", "HEAD", "--git-path", "index"],
      gitOptions(options),
    );
    // Only HEAD occupies a fixed line; the index path can contain newlines.
    const separator = metadata.indexOf("\n");
    const head = metadata.slice(0, separator).trimEnd();
    if (head !== template.record.sourceCommit) {
      throw new Error("worktree base moved during template preparation");
    }
    const destinationIndex = path.resolve(
      options.destination,
      normalizeGitPathForFilesystem(metadata.slice(separator + 1)),
    );
    assertOwned(options);
    await fs.unlink(markerPath);
    assertOwned(options);
    await fs.rmdir(options.destination);
    options.requireSpace(cloneBytes);
    await template.backend.cloneTemplate(template.record.path, options.destination, options);
    const cloneCompletedAtMs = Date.now();
    assertOwned(options);
    // Git marks this file hidden on Windows; opening that clone with O_CREAT
    // fails. Replace the template's link with this worktree's own registration.
    await fs.unlink(markerPath);
    assertOwned(options);
    await fs.writeFile(markerPath, marker);
    const sourceIndex = template.sourceIndex;
    assertOwned(options);
    let copied = false;
    if (template.backend.id === "apfs") {
      const { copyApfsCloneIndex } = await import("./checkout-apfs.js");
      copied = await copyApfsCloneIndex(
        template.record.path,
        options.destination,
        sourceIndex,
        destinationIndex,
        { ...options, cloneCompletedAtMs },
      );
    }
    if (!copied) {
      assertOwned(options);
      await fs.copyFile(sourceIndex, destinationIndex, constants.COPYFILE_FICLONE);
    }
    // Git validates every remaining stat mismatch and retains normal edit detection.
    assertOwned(options);
    await requireGit(options.destination, ["update-index", "--refresh"], {
      ...gitOptions(options),
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    });
    return { ...added, templateCloned: true };
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
    let checkout: GitResult;
    try {
      if (options.deferGitCheckout) {
        options.requireSpace();
        return added;
      }
      checkout = await runGit(options.destination, ["reset", "--hard", "HEAD"], {
        ...gitOptions(options),
        beforeRun: () => {
          assertOwned(options);
          options.requireSpace();
        },
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      });
    } catch (fallbackError) {
      await removeFailedCheckout(options);
      throw fallbackError;
    }
    if (checkout.code !== 0) {
      await removeFailedCheckout(options);
    }
    return checkout.code === 0 ? added : checkout;
  }
}

async function removeFailedCheckout(options: CheckoutOptions): Promise<void> {
  assertOwned(options);
  await requireGit(
    options.repoRoot,
    ["worktree", "remove", "--force", options.destination],
    gitOptions(options),
  );
  if (options.branch) {
    assertOwned(options);
    await requireGit(options.repoRoot, ["branch", "-D", options.branch], gitOptions(options));
  }
}
