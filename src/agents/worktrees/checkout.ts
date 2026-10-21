import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "../../infra/fs-safe.js";
import {
  normalizeGitPathForFilesystem,
  requireGitCommandOutput,
  type GitCommandOptions,
} from "../../infra/git-exec.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import type { WorktreeWaitBudget } from "./allocation.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { prepareWorktreePromptFiles } from "./checkout-inputs.js";
import { materializeManagedWorktree } from "./checkout-materialize.js";
import { resolveWorktreeCheckoutKey } from "./checkout-policy-key.js";
import type { WorktreeSourceProfile } from "./checkout-profiles.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
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
import {
  setWorktreePreparationTemplate,
  timeWorktreePreparationPhase,
} from "./preparation-timing.js";
import { prepareWorktreeTemplate } from "./template-cache.js";

const log = createSubsystemLogger("agents/worktrees");

type CheckoutOptions = WorktreeFilesystemOptions & {
  waitBudget?: WorktreeWaitBudget;
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
  onPromptReady?: (commit: string) => Promise<void>;
  rollbackGuard?: () => void;
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
    env: { GIT_NO_LAZY_FETCH: "1" },
    refMutationDirectory: options.commonDir,
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

async function prepareTemplate(options: CheckoutOptions) {
  const backend = await detectWorktreeFilesystemBackend(path.dirname(options.destination), options);
  if (!backend) {
    return undefined;
  }
  // Registration already pinned this commit before template selection.
  const commit = options.base;
  return await withWorktreeGitConfig(
    options.destination,
    options.sourceOnly === true,
    gitOptions(options),
    async (git) => {
      setWorktreePreparationTemplate("unavailable", { reason: "checkout-policy" });
      const contentKey = await resolveWorktreeCheckoutKey({
        commonDir: options.commonDir,
        destination: options.destination,
        commit,
        gitOptions: gitOptions(options),
        git,
      });
      if (!contentKey) {
        return undefined;
      }
      const cacheKey = createHash("sha256")
        .update(`${options.commonDir}\n${options.worktreeRoot}`)
        .digest("hex");
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
        validate: async (existing, templateOptions) => {
          // --list includes this worktree's config.worktree when the extension is enabled.
          // A clean sparse template can otherwise look identical to a full checkout.
          if (
            (await resolveWorktreeCheckoutKey({
              ...options,
              ...templateOptions,
              destination: existing.path,
              commit: existing.sourceCommit,
              git,
              gitOptions: gitOptions({ ...options, ...templateOptions }),
            })) !== existing.contentKey
          ) {
            return false;
          }
          const status = await git.run(
            existing.path,
            ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored"],
            gitOptions(templateOptions),
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
            heads[0] === `# branch.oid ${existing.sourceCommit}`
          );
        },
        refresh: async (existing, templateOptions) => {
          // Attribute changes can transform unchanged blobs; rebuild those trees.
          const attributes = await git.run(
            existing.path,
            [
              "diff-tree",
              "--quiet",
              "-r",
              existing.sourceCommit,
              commit,
              "--",
              ":(glob)**/.gitattributes",
            ],
            gitOptions(templateOptions),
          );
          if (
            attributes.code !== 0 ||
            attributes.termination !== "exit" ||
            (await resolveWorktreeCheckoutKey({
              ...options,
              destination: existing.path,
              commit,
              git,
              gitOptions: gitOptions(templateOptions),
            })) !== contentKey
          ) {
            return false;
          }
          const materialized = await materializeManagedWorktree(
            {
              destination: existing.path,
              commit,
              preparedGit: git,
              executionTimeoutMs: options.checkoutBudget?.timeoutMs,
            },
            checkoutGitOptions({ ...options, ...templateOptions }),
          );
          requireGitCommandOutput("git read-tree", materialized);
          await git.require(
            existing.path,
            ["update-ref", "--no-deref", "HEAD", commit, existing.sourceCommit],
            gitOptions(templateOptions),
          );
          return true;
        },
        prepare: async (preparing, templateOptions) => {
          await options.requireSpace();
          setWorktreePreparationTemplate("cold", { reason: "template-create" });
          await backend.createTemplate(preparing.path, templateOptions);
          await git.require(
            options.repoRoot,
            ["worktree", "add", "--detach", "--no-checkout", "--", preparing.path, commit],
            checkoutGitOptions({ ...options, ...templateOptions }),
          );
          if (
            (await resolveWorktreeCheckoutKey({
              ...options,
              ...templateOptions,
              destination: preparing.path,
              commit,
              git,
              gitOptions: gitOptions({ ...options, ...templateOptions }),
            })) !== contentKey
          ) {
            throw new Error("Template and target checkout configurations differ");
          }
          setWorktreePreparationTemplate("cold", { reason: "template-checkout" });
          const materialized = await materializeManagedWorktree(
            {
              destination: preparing.path,
              commit,
              preparedGit: git,
              executionTimeoutMs: options.checkoutBudget?.timeoutMs,
            },
            checkoutGitOptions({ ...options, ...templateOptions }),
          );
          requireGitCommandOutput("git read-tree", materialized);
        },
      });
      try {
        return record
          ? {
              record,
              backend,
              sourceIndex: await resolveGitMetadataPath(record.path, "index", gitOptions(options)),
            }
          : undefined;
      } catch (error) {
        await record?.release(error);
        throw error;
      }
    },
  );
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
  const added = await timeWorktreePreparationPhase("registration", () =>
    runGit(
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
    ),
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
      {
        destination: options.destination,
        commit,
        sourceOnly: options.sourceOnly,
        executionTimeoutMs: options.checkoutBudget?.timeoutMs,
      },
      checkoutGitOptions(options),
    );
    if (result.code === 0) {
      await assertRegistration();
    }
    return result.code === 0 ? added : result;
  };
  let retainedTemplate: Awaited<ReturnType<typeof prepareTemplate>>;
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
    setWorktreePreparationTemplate("unavailable", {
      reason: !options.enabled
        ? "disabled"
        : checkoutBytes === 0
          ? "empty-checkout"
          : profile
            ? "source-profile"
            : "template-prepare",
    });
    if (options.enabled && checkoutBytes !== 0 && !profile) {
      try {
        template = retainedTemplate = await timeWorktreePreparationPhase("templatePrepare", () =>
          prepareTemplate(options),
        );
        cloneBytes = template ? await estimateTemplateCloneBytes(template) : undefined;
        if (template) {
          setWorktreePreparationTemplate(undefined, { reason: "ready", cloneBytes });
        }
      } catch (error) {
        if (hasWorktreeUnknownOutcome(error)) {
          throw error;
        }
        assertOwned(options);
        setWorktreePreparationTemplate("unavailable", {
          errorCode: error instanceof Error && "code" in error ? String(error.code) : "unknown",
        });
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
      setWorktreePreparationTemplate("unavailable", { reason: "clone-disk-admission", cloneBytes });
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
      if (
        !options.deferGitCheckout &&
        options.onPromptReady &&
        (await withWorktreeGitConfig(
          options.destination,
          options.sourceOnly === true,
          gitOptions(options),
          (git) =>
            prepareWorktreePromptFiles({
              repoRoot: options.repoRoot,
              commonDir: options.commonDir,
              commit,
              destination: options.destination,
              git,
              gitOptions: gitOptions(options),
              checkoutOptions: checkoutGitOptions(options),
              onMaterializationStart: () => {
                materializationStarted = true;
              },
            }),
        ))
      ) {
        await assertRegistration();
        assertOwned(options);
        await options.onPromptReady(commit);
        assertOwned(options);
      }
      const result = options.deferGitCheckout ? added : await checkout();
      return result;
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
      await timeWorktreePreparationPhase("indexRefresh", () =>
        withWorktreeGitConfig(
          options.destination,
          options.sourceOnly === true,
          gitOptions(options),
          (git) =>
            git.require(options.destination, ["update-index", "--refresh"], {
              ...gitOptions(options),
              timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
              ...options.checkoutBudget,
            }),
        ),
      );
    } catch (error) {
      if (hasWorktreeUnknownOutcome(error)) {
        throw error;
      }
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
      setWorktreePreparationTemplate("unavailable", {
        reason: "clone-failed",
        errorCode: error instanceof Error && "code" in error ? String(error.code) : "unknown",
      });
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
  await retainedTemplate?.record.release("error" in outcome ? outcome.error : undefined);
  const failures = "error" in outcome ? [outcome.error] : [];
  if (
    ("error" in outcome || outcome.result.code !== 0) &&
    !preserve &&
    !("error" in outcome && hasWorktreeUnknownOutcome(outcome.error))
  ) {
    try {
      rollbackGuard();
      await assertRegistration(rollbackOptions);
      if (!materializationStarted) {
        await assertUnprepared(rollbackOptions);
      }
      await removeFailedCheckout({ ...options, signal: undefined, commitGuard: rollbackGuard });
    } catch (error) {
      // Lost cleanup authority leaves the registration for inspection, even when still empty.
      failures.push(error);
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
