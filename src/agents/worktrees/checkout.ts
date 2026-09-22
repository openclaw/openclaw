import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorktreeSourceProfile } from "./checkout-profiles.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import {
  commandError,
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
  branch?: string | { mode: "existing"; name: string };
  sourceProfile?: WorktreeSourceProfile;
  prepareCommit?: (commit: string) => Promise<void>;
  rollbackGuard?: () => void;
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
// Hash effective checkout configuration so policy changes retire the cache.
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
  const checkoutConfig: string[] = [];
  for (const field of config.split("\0")) {
    const key = field.split("\n", 1)[0]?.toLowerCase() ?? "";
    // Branch settings govern tracking and merge behavior, not checkout contents.
    // Registration adds remote/merge keys; deleting the branch removes them.
    if (key.startsWith("branch.")) {
      continue;
    }
    if (
      /^(filter\.|includeif\.|core\.(attributesfile|worktree|sparsecheckout|splitindex)$|extensions\.worktreeconfig$|index\.sparse$)/u.test(
        key,
      )
    ) {
      return undefined;
    }
    checkoutConfig.push(field);
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
  return digest(`source-v1\n${commit}\n${checkoutConfig.join("\0")}`);
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
export async function addManagedWorktree(input: CheckoutOptions): Promise<CheckoutResult> {
  const existingBranch = typeof input.branch === "object" ? input.branch.name : undefined;
  const createdBranch = typeof input.branch === "string" ? input.branch : undefined;
  const expectedRef = existingBranch ? `refs/heads/${existingBranch}` : undefined;
  const expectedCommit = expectedRef
    ? await requireGit(
        input.repoRoot,
        ["rev-parse", "--verify", `${input.base}^{commit}`],
        gitOptions(input),
      )
    : undefined;
  const assertExistingSeed = async () => {
    if (!expectedRef) {
      return;
    }
    await requireGit(input.repoRoot, ["check-ref-format", expectedRef], gitOptions(input));
    const actual = await requireGit(
      input.repoRoot,
      ["rev-parse", "--verify", expectedRef],
      gitOptions(input),
    );
    const worktrees = await requireGit(
      input.repoRoot,
      ["worktree", "list", "--porcelain", "-z"],
      gitOptions(input),
    );
    if (actual !== expectedCommit || worktrees.split("\0").includes(`branch ${expectedRef}`)) {
      throw new Error("Caller-owned worktree branch moved or is in use; preserve it for recovery.");
    }
  };
  await assertExistingSeed();
  const profile = input.sourceProfile;
  if (profile) {
    if (input.deferGitCheckout || (await worktreePathExists(input.destination))) {
      throw new Error(
        "Source profiles require a fresh destination; preserve existing work and choose a new path.",
      );
    }
    const commit = await requireGit(
      input.repoRoot,
      ["rev-parse", "--verify", `${input.base}^{commit}`],
      gitOptions(input),
    );
    if (commit !== profile.commit) {
      throw new Error("Worktree source profile does not match the checkout commit.");
    }
  }
  await assertExistingSeed();
  const added = await runGit(
    input.repoRoot,
    [
      "worktree",
      "add",
      "--no-checkout",
      ...(existingBranch ? [] : createdBranch ? ["-b", createdBranch] : ["--detach"]),
      "--",
      input.destination,
      existingBranch ?? input.base,
    ],
    {
      ...gitOptions(input),
      beforeRun: () => {
        assertOwned(input);
        input.requireSpace(0);
      },
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    },
  );
  if (added.code !== 0) {
    return added;
  }
  const rollbackGuard = input.rollbackGuard ?? input.commitGuard;
  const rollbackOptions = { beforeRun: rollbackGuard, killProcessTree: true };
  // Capture through allocation authority even when the caller just cancelled.
  // During a partial clone the destination's .git may point at the template.
  const gitDir = normalizeGitPathForFilesystem(
    await requireGit(input.destination, ["rev-parse", "--absolute-git-dir"], rollbackOptions),
  );
  const readRegistration = (commandOptions: Parameters<typeof requireGit>[2]) =>
    requireGit(
      input.repoRoot,
      ["--git-dir", gitDir, "rev-parse", "HEAD", "--symbolic-full-name", "HEAD"],
      commandOptions,
    );
  const registration = await readRegistration(rollbackOptions);
  const [commit, headRef] = registration.split("\n");
  const expectedHeadRef = expectedRef ?? (createdBranch ? `refs/heads/${createdBranch}` : "HEAD");
  if (!commit || headRef !== expectedHeadRef || (expectedCommit && commit !== expectedCommit)) {
    throw new Error("Worktree registration changed during creation; preserve it for recovery.");
  }
  const options = { ...input, base: commit };
  // Native PR owns its seed and partial checkout, including cancellation failures.
  let preserve = Boolean(existingBranch);
  let materializationStarted = false;
  const assertRegistration = async (
    commandOptions: Parameters<typeof requireGit>[2] = gitOptions(options),
  ) => {
    if ((await readRegistration(commandOptions)) !== registration) {
      preserve = true;
      throw new Error("Worktree HEAD changed during preparation; preserve it for recovery.");
    }
  };
  const assertUnprepared = async (commandOptions: Parameters<typeof requireGit>[2]) => {
    const entries = await fs.readdir(options.destination);
    if (entries.length !== 1 || entries[0] !== ".git") {
      preserve = true;
      throw new Error(
        "Worktree target is no longer unprepared; preserve it and choose a new path.",
      );
    }
    await assertRegistration(commandOptions);
  };
  const checkout = async (): Promise<CheckoutResult> => {
    await assertRegistration();
    materializationStarted = true;
    const result = await runGit(
      options.destination,
      ["read-tree", "--reset", "--no-recurse-submodules", "-u", commit],
      {
        ...gitOptions(options),
        beforeRun: () => {
          assertOwned(options);
          options.requireSpace();
        },
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      },
    );
    if (result.code === 0) {
      await assertRegistration();
    }
    return result.code === 0 ? added : result;
  };
  const prepare = async (): Promise<CheckoutResult> => {
    if (profile && commit !== profile.commit) {
      preserve = true;
      throw new Error(
        "Worktree source commit changed before sparse materialization; preserve it for recovery.",
      );
    }
    await options.prepareCommit?.(commit);
    let template: Awaited<ReturnType<typeof prepareTemplate>>;
    let cloneBytes: number | undefined;
    if (options.enabled && !profile) {
      try {
        template = await prepareTemplate(options);
        cloneBytes = template ? await estimateTemplateCloneBytes(template) : undefined;
      } catch (error) {
        assertOwned(options);
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
      // Tiny trees can need less space than the conservative clone metadata allowance.
      options.requireSpace();
      template = undefined;
      cloneBytes = undefined;
    }
    await assertUnprepared(gitOptions(options));
    if (profile) {
      // Partial sparse materialization remains available for recovery, never rollback.
      preserve = true;
      await requireGit(
        options.destination,
        ["sparse-checkout", "set", "--cone", "--no-sparse-index", "--stdin"],
        {
          ...gitOptions(options),
          input: `${profile.directories.join("\n")}\n`,
          beforeRun: () => {
            assertOwned(options);
            options.requireSpace();
          },
          timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        },
      );
      const result = await checkout();
      if (result.code !== 0) {
        throw commandError("git read-tree", result);
      }
      return result;
    }
    if (!template) {
      return options.deferGitCheckout ? added : await checkout();
    }
    const destinationIndex = path.resolve(
      options.repoRoot,
      normalizeGitPathForFilesystem(
        await requireGit(
          options.repoRoot,
          ["--git-dir", gitDir, "rev-parse", "--git-path", "index"],
          gitOptions(options),
        ),
      ),
    );
    const markerPath = path.join(options.destination, ".git");
    const marker = await fs.readFile(markerPath);
    let destinationRemoved = false;
    try {
      assertOwned(options);
      await fs.unlink(markerPath);
      assertOwned(options);
      await fs.rmdir(options.destination);
      destinationRemoved = true;
      materializationStarted = true;
      options.requireSpace(cloneBytes);
      await template.backend.cloneTemplate(template.record.path, options.destination, options);
      const cloneCompletedAtMs = Date.now();
      await assertRegistration();
      assertOwned(options);
      // Windows marks Git's link hidden; replace the cloned link before writing ours.
      await fs.unlink(markerPath);
      assertOwned(options);
      await fs.writeFile(markerPath, marker);
      let copied = false;
      if (template.backend.id === "apfs") {
        const { copyApfsCloneIndex } = await import("./checkout-apfs.js");
        copied = await copyApfsCloneIndex(
          template.record.path,
          options.destination,
          template.sourceIndex,
          destinationIndex,
          {
            ...options,
            cloneCompletedAtMs,
          },
        );
      }
      if (!copied) {
        assertOwned(options);
        await fs.copyFile(template.sourceIndex, destinationIndex, constants.COPYFILE_FICLONE);
      }
      await requireGit(options.destination, ["update-index", "--refresh"], {
        ...gitOptions(options),
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      });
    } catch (error) {
      rollbackGuard();
      await assertRegistration(rollbackOptions);
      if (existingBranch) {
        throw new Error(
          "Caller-owned worktree clone failed; preserve its registration and partial checkout for recovery.",
          { cause: error },
        );
      }
      if (!destinationRemoved) {
        preserve = true;
        if (!(await worktreePathExists(markerPath))) {
          rollbackGuard();
          await fs.writeFile(markerPath, marker, { flag: "wx" });
        }
        throw error;
      }
      rollbackGuard();
      await fs.rm(options.destination, { recursive: true, force: true });
      rollbackGuard();
      await fs.mkdir(options.destination);
      rollbackGuard();
      await fs.writeFile(markerPath, marker);
      assertOwned(options);
      log.warn(`worktree snapshot failed; using Git checkout: ${String(error)}`);
      if (options.deferGitCheckout) {
        options.requireSpace();
        return added;
      }
      return await checkout();
    }
    await assertRegistration();
    return { ...added, templateCloned: true };
  };
  let failed = true;
  try {
    const result = await prepare();
    failed = result.code !== 0;
    return result;
  } finally {
    if (failed && !preserve) {
      rollbackGuard();
      await assertRegistration(rollbackOptions);
      if (!materializationStarted) {
        await assertUnprepared(rollbackOptions);
      }
      await removeFailedCheckout({ ...options, signal: undefined, commitGuard: rollbackGuard });
    }
  }
}

async function removeFailedCheckout(options: CheckoutOptions): Promise<void> {
  assertOwned(options);
  await requireGit(
    options.repoRoot,
    ["worktree", "remove", "--force", options.destination],
    gitOptions(options),
  );
  if (typeof options.branch === "string") {
    assertOwned(options);
    await requireGit(options.repoRoot, ["branch", "-D", options.branch], gitOptions(options));
  }
}
