import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { normalizeGitPathForFilesystem, type GitCommandOptions } from "../../infra/git-exec.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import type { WorktreeSourceProfile } from "./checkout-profiles.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import {
  commandError,
  worktreePathExists,
  requireGit,
  resolveGitMetadataPath,
  runGit,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
  type GitResult,
} from "./git.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";
import { prepareWorktreeTemplate } from "./template-cache.js";

const log = createSubsystemLogger("agents/worktrees");

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
  /** Hydrate the registered commit and return its estimated checkout bytes. */
  prepareCommit?: (commit: string) => Promise<number>;
  rollbackGuard?: () => void;
  /** Unwind source custody before the service reacquires allocation for an untouched registration. */
  deferUnpreparedCleanup?: (cleanup: (assertCurrent: () => void) => Promise<void>) => void;
  /** Restore reuses a warm template, or materializes its snapshot after registration. */
  deferGitCheckout?: boolean;
  /** This source is consumed by a sandboxed session, never host filter programs. */
  sourceOnly?: boolean;
  checkoutBudget?: Pick<GitCommandOptions, "timeoutMs" | "killGraceMs">;
  requireSpace: (cloneBytes?: number) => Promise<void>;
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

function checkoutGitOptions(options: CheckoutOptions, cloneBytes?: number): GitCommandOptions {
  return {
    ...gitOptions(options),
    startRun: async <T>(run: () => T): Promise<Awaited<T>> => {
      assertOwned(options);
      await options.requireSpace(cloneBytes);
      assertOwned(options);
      return await run();
    },
    timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    ...options.checkoutBudget,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  const record = await prepareWorktreeTemplate({
    env: options.env,
    now: options.now,
    options,
    cacheKey,
    contentKey,
    repoRoot: options.repoRoot,
    commonDir: options.commonDir,
    worktreeRoot: options.worktreeRoot,
    sourceCommit: commit,
    backend: backend.id,
    reuseOnly: options.deferGitCheckout,
    requireSpace: options.requireSpace,
    validate: async (existing) => {
      const status = await runGit(
        existing.path,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored"],
        gitOptions(options),
      );
      // NUL records keep filenames from impersonating HEAD headers.
      const fields = status.stdout.split("\0");
      const heads = fields.filter((field) => field.startsWith("# branch.oid "));
      return (
        status.termination === "exit" &&
        status.code === 0 &&
        !status.stdoutTruncatedBytes &&
        fields.pop() === "" &&
        fields.every((field) => field.startsWith("# ")) &&
        heads.length === 1 &&
        heads[0] === `# branch.oid ${commit}`
      );
    },
    prepare: async (preparing) => {
      await options.requireSpace();
      await backend.createTemplate(preparing.path, options);
      await requireGit(
        options.repoRoot,
        ["worktree", "add", "--detach", "--", preparing.path, commit],
        checkoutGitOptions(options),
      );
    },
  });
  return record
    ? {
        record,
        backend,
        sourceIndex: await resolveGitMetadataPath(record.path, "index", gitOptions(options)),
      }
    : undefined;
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
  if (input.sourceOnly && profile) {
    throw new Error("Source-only session checkouts do not support repository source profiles");
  }
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
    checkoutGitOptions(input, 0),
  );
  if (added.code !== 0) {
    return added;
  }
  const rollbackGuard = input.rollbackGuard ?? input.commitGuard;
  const rollbackOptions = { beforeRun: rollbackGuard, killProcessTree: true };
  // Capture rollback-owned metadata before cloning replaces .git; keep relative Git env paths anchored.
  const absolute = await resolveGitMetadataPath(input.destination, ".", rollbackOptions);
  const relative = path.relative(input.repoRoot, absolute);
  const gitDir = Buffer.byteLength(relative) < Buffer.byteLength(absolute) ? relative : absolute;
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
  const destinationIdentity = await fs.lstat(options.destination);
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
    const result = await materializeManagedWorktree(
      { destination: options.destination, commit, sourceOnly: options.sourceOnly },
      checkoutGitOptions(options),
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
    const checkoutBytes = await options.prepareCommit?.(commit);
    let template: Awaited<ReturnType<typeof prepareTemplate>>;
    let cloneBytes: number | undefined;
    if (options.enabled && checkoutBytes !== 0 && !profile && !options.sourceOnly) {
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
      await options.requireSpace(cloneBytes);
    } catch (error) {
      if (!template) {
        throw error;
      }
      // Tiny trees can need less space than the conservative clone metadata allowance.
      await options.requireSpace();
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
          ...checkoutGitOptions(options),
          input: `${profile.directories.join("\n")}\n`,
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
      await options.requireSpace(cloneBytes);
      const { backend, record } = template;
      await timeWorktreePreparationPhase("templateApply", () =>
        backend.cloneTemplate(record.path, options.destination, options),
      );
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
        const sourceIndex = await fs.realpath(template.sourceIndex);
        const [sourceRoot, destinationRoot] = await Promise.all([
          fsRoot(path.dirname(sourceIndex)),
          fsRoot(path.dirname(destinationIndex)),
        ]);
        await destinationRoot.copyIn(
          path.basename(destinationIndex),
          { root: sourceRoot, relativePath: `./${path.basename(sourceIndex)}` },
          {
            clone: "auto",
            durable: false,
            mkdir: false,
            overwrite: true,
            preserveSourceMode: true,
            sourceHardlinks: "allow",
            signal: options.signal,
            assertBeforeMutation: () => assertOwned(options),
          },
        );
      }
      await requireGit(options.destination, ["update-index", "--refresh"], {
        ...gitOptions(options),
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        ...options.checkoutBudget,
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
        await options.requireSpace();
        return added;
      }
      return await checkout();
    }
    await assertRegistration();
    return { ...added, templateCloned: true };
  };
  let outcome: { result: CheckoutResult } | { error: unknown };
  try {
    outcome = { result: await prepare() };
  } catch (error) {
    outcome = { error };
  }
  const failures = "error" in outcome ? [outcome.error] : [];
  if (("error" in outcome || outcome.result.code !== 0) && !preserve) {
    try {
      rollbackGuard();
      await assertRegistration(rollbackOptions);
      if (!materializationStarted) {
        await assertUnprepared(rollbackOptions);
      }
      await removeFailedCheckout({ ...options, signal: undefined, commitGuard: rollbackGuard });
    } catch (error) {
      if (
        materializationStarted ||
        preserve ||
        !options.deferUnpreparedCleanup ||
        !(error instanceof OpenClawStateLeaseError) ||
        error.code !== "OPENCLAW_STATE_LEASE_LOST"
      ) {
        failures.push(error);
      } else {
        options.deferUnpreparedCleanup(async (assertCurrent) => {
          const current = await fs.lstat(options.destination);
          if (
            !current.isDirectory() ||
            current.dev !== destinationIdentity.dev ||
            current.ino !== destinationIdentity.ino
          ) {
            throw new Error("Worktree target changed before cleanup; checkout preserved.", {
              cause: error,
            });
          }
          const recoveryOptions = { beforeRun: assertCurrent, killProcessTree: true };
          if (
            (await resolveGitMetadataPath(options.destination, ".", recoveryOptions)) !== absolute
          ) {
            throw new Error("Worktree registration changed before cleanup; checkout preserved.", {
              cause: error,
            });
          }
          await assertUnprepared(recoveryOptions);
          await removeFailedCheckout({ ...options, signal: undefined, commitGuard: assertCurrent });
        });
      }
    }
  }
  if (failures.length > 1) {
    const failure = new AggregateError(failures, failures.map(String).join("\n"), {
      cause: failures[0],
    });
    const primary = failures[0];
    if (primary instanceof OpenClawStateLeaseError) {
      throw new OpenClawStateLeaseError(primary.message, { code: primary.code, cause: failure });
    }
    throw failure;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  return outcome.result;
}

/** Materialization and restore share one filter-safe operation boundary. */
export async function materializeManagedWorktree(
  params: {
    destination: string;
    commit: string;
    sourceOnly?: boolean;
    resetIndexTo?: string;
    removeExisting?: boolean;
  },
  options: GitCommandOptions,
  indexOptions: GitCommandOptions = options,
): Promise<GitResult> {
  return await withWorktreeGitConfig(
    params.destination,
    params.sourceOnly === true,
    indexOptions,
    async (git) => {
      if (params.removeExisting) {
        await git.require(
          params.destination,
          ["rm", "-r", "--force", "--ignore-unmatch", "--", "."],
          options,
        );
      }
      const result = await git.run(
        params.destination,
        ["read-tree", "--reset", "--no-recurse-submodules", "-u", params.commit],
        options,
      );
      if (result.code === 0 && params.resetIndexTo) {
        await git.require(
          params.destination,
          params.sourceOnly ? ["read-tree", "--reset", params.resetIndexTo] : ["reset"],
          indexOptions,
        );
      }
      return result;
    },
  );
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
