import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";
import { normalizeGitPathForFilesystem, requireGitCommandOutput } from "../../infra/git-exec.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  CommandProcessCleanupError,
  readCommandProcessFailure,
} from "../../process/exec-result.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { estimateWorktreeGitBytes } from "./capacity.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import { commandError, listGitWorktrees, requireGit, runGit } from "./git.js";
import type { CreateManagedWorktreeParams } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

type ResolvedWorktreeBase = {
  commit: string;
  gitOperand: string;
  recordRef: string;
  fetchSucceeded?: boolean;
  warning?: string;
  preparationKey?: string;
};

type RemoteDefaultAttempt = {
  pending: Promise<ResolvedWorktreeBase & { branch: string }>;
  ownerInvalidated: boolean;
};
type RemoteDefaultPreparation = { borrowers: number; attempt?: RemoteDefaultAttempt };
export type WorktreeBasePreparation = (options: {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  localDefault?: "preserve" | "fast-forward";
}) => Promise<ResolvedWorktreeBase>;

const remoteDefaults = resolveGlobalMap<string, RemoteDefaultPreparation>(
  Symbol.for("openclaw.worktreeRemoteDefaults"),
);

export class InvalidWorktreeBaseRefError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Worktree base ref does not resolve to a commit. Choose a local or remote branch and retry.",
      options,
    );
    this.name = "InvalidWorktreeBaseRefError";
  }
}

export async function resolveWorktreeCreationBase(
  repoRoot: string,
  params: Pick<
    CreateManagedWorktreeParams,
    "baseRef" | "checkoutCommit" | "signal" | "commitGuard"
  > & {
    prepareBase?: WorktreeBasePreparation;
  },
): Promise<ResolvedWorktreeBase> {
  if (params.checkoutCommit) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.checkoutCommit)) {
      throw new Error("Worktree checkout commit is invalid");
    }
    return {
      commit: params.checkoutCommit,
      gitOperand: params.checkoutCommit,
      recordRef: params.baseRef ?? params.checkoutCommit,
      fetchSucceeded: undefined,
      warning: undefined,
    };
  }
  return params.prepareBase && !params.baseRef
    ? await params.prepareBase({
        signal: params.signal,
        assertCurrent: params.commitGuard,
        localDefault: "fast-forward",
      })
    : await resolveWorktreeBase(
        repoRoot,
        params.baseRef,
        params.signal,
        params.commitGuard,
        "fast-forward",
      );
}

export async function resolveWorktreeBase(
  repoRoot: string,
  baseRef?: string,
  signal?: AbortSignal,
  assertCurrent?: () => void,
  localDefault: "preserve" | "fast-forward" = "preserve",
): Promise<ResolvedWorktreeBase> {
  if (baseRef) {
    const verified = await runGit(
      repoRoot,
      [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef === "-" ? "@{-1}" : baseRef}^{commit}`,
      ],
      { signal, beforeRun: assertCurrent },
    );
    signal?.throwIfAborted();
    if (
      verified.termination === "exit" &&
      typeof verified.code === "number" &&
      verified.code !== 0
    ) {
      throw new InvalidWorktreeBaseRefError({
        cause: commandError("git rev-parse --verify", verified),
      });
    }
    const commit = requireGitCommandOutput("git rev-parse --verify", verified).trim();
    if (!commit || commit.includes("\n") || verified.stderr.trim()) {
      throw new InvalidWorktreeBaseRefError({
        cause: commandError("git rev-parse --verify", verified),
      });
    }
    // `worktree add -b` forwards its start point to `git branch`, which parses
    // options again without another `--`; pass the verified commit for dashed refs.
    const gitOperand = baseRef !== "-" && baseRef.startsWith("-") ? commit : baseRef;
    return { commit, gitOperand, recordRef: baseRef };
  }
  const options = {
    signal,
    beforeRun: () => {
      signal?.throwIfAborted();
      assertCurrent?.();
    },
    env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  };
  const commonDir = await fs.realpath(
    path.resolve(
      repoRoot,
      normalizeGitPathForFilesystem(
        await requireGit(repoRoot, ["rev-parse", "--git-common-dir"], options),
      ),
    ),
  );
  const checkout = await fs.realpath(repoRoot);
  return await withWorktreeBasePreparation({ repoRoot: checkout, commonDir }, (resolve) =>
    resolve({ signal, assertCurrent, localDefault }),
  );
}

/** Capture a creation cohort before capacity waits, without fetching until a source owner consumes it. */
export async function withWorktreeBasePreparation<T>(
  repository: { repoRoot: string; commonDir: string },
  run: (resolve: WorktreeBasePreparation) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify(
    [repository.commonDir, repository.repoRoot].map((directory) =>
      process.platform === "win32" ? directory.toLowerCase() : directory,
    ),
  );
  const shared: RemoteDefaultPreparation = remoteDefaults.get(key) ?? { borrowers: 0 };
  shared.borrowers++;
  remoteDefaults.set(key, shared);
  const forget = () => {
    if (remoteDefaults.get(key) === shared) {
      remoteDefaults.delete(key);
    }
  };
  let active = true;
  const resolutions: Promise<ResolvedWorktreeBase>[] = [];
  const resolve: WorktreeBasePreparation = async ({
    signal,
    assertCurrent,
    localDefault = "preserve",
  }) => {
    const options = {
      signal,
      beforeRun: () => {
        if (!active) {
          throw new Error("Worktree base preparation is closed");
        }
        signal?.throwIfAborted();
        assertCurrent?.();
      },
      env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    };
    for (;;) {
      options.beforeRun();
      let attempt = shared.attempt;
      if (!attempt) {
        const started: RemoteDefaultAttempt = {
          ownerInvalidated: false,
          pending: fetchRemoteDefault(repository.repoRoot, options)
            .then(async (base) => {
              // The creation cohort shares hydration before any checkout, including local main.
              const preparationKey = randomUUID();
              await estimateWorktreeGitBytes(repository.repoRoot, base.commit, {
                signal,
                assertCurrent: options.beforeRun,
                preparationKey,
              });
              base.preparationKey = preparationKey;
              options.beforeRun();
              return base;
            })
            .catch((error: unknown) => {
              if (hasWorktreeUnknownOutcome(error)) {
                throw error;
              }
              if (readCommandProcessFailure(error)?.cleanup === "uncertain") {
                throw new CommandProcessCleanupError({ cause: error });
              }
              // Record authority while its scope is live; later borrowers outlive this caller.
              try {
                options.beforeRun();
              } catch {
                started.ownerInvalidated = true;
              }
              throw error;
            })
            .finally(forget),
        };
        shared.attempt = attempt = started;
      }
      let selected: Awaited<typeof attempt.pending>;
      try {
        selected = await attempt.pending;
      } catch (error) {
        // Unconfirmed native work retains recovery custody even after this caller is revoked.
        if (hasWorktreeUnknownOutcome(error)) {
          throw error;
        }
        options.beforeRun();
        // A canceled owner settles its process before a live borrower retries with its own guard.
        if (attempt.ownerInvalidated) {
          if (shared.attempt === attempt) {
            shared.attempt = undefined;
          }
          continue;
        }
        throw error;
      }
      options.beforeRun();
      const { branch, ...base } = selected;
      const warning =
        localDefault === "fast-forward"
          ? await fastForwardLocalDefault(repository.repoRoot, branch, base.commit, options)
          : undefined;
      return warning
        ? {
            ...base,
            warning: [base.warning, redactSensitiveText(warning)].filter(Boolean).join("\n"),
          }
        : base;
    }
  };
  try {
    return await run((options) => {
      const pending = resolve(options);
      resolutions.push(pending);
      return pending;
    });
  } finally {
    active = false;
    if (--shared.borrowers === 0 && !shared.attempt) {
      forget();
    }
    await Promise.allSettled(resolutions);
  }
}

async function fetchRemoteDefault(
  repoRoot: string,
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<ResolvedWorktreeBase & { branch: string }> {
  const cached = await runGit(
    repoRoot,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    options,
  );
  const advertised = await runGit(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"], {
    ...options,
    timeoutMs: 30_000,
  });
  options.signal?.throwIfAborted();
  const advertisedOk = advertised.termination === "exit" && advertised.code === 0;
  const advertisedBranch = advertisedOk
    ? /^ref: refs\/heads\/(.+)\tHEAD\r?$/mu.exec(advertised.stdout)?.[1]
    : undefined;
  const cachedBranch =
    cached.termination === "exit" && cached.code === 0
      ? /^refs\/remotes\/origin\/(.+)$/u.exec(cached.stdout.trim())?.[1]
      : undefined;
  let branch = advertisedBranch ?? cachedBranch;
  const warnings: string[] = [];
  if (!advertisedOk) {
    warnings.push(commandError("git ls-remote origin HEAD", advertised).message);
  } else if (!advertisedBranch) {
    warnings.push("origin did not advertise a default branch; using its cached default.");
  }
  if (!branch || branch === "HEAD") {
    throw new Error(
      `Remote default branch is unavailable. Repair origin or choose an explicit worktree base ref. ${redactSensitiveText(warnings.join("\n"))}`,
    );
  }
  let remoteRef = `refs/remotes/origin/${branch}`;
  const fetched = await runGit(
    repoRoot,
    [
      "fetch",
      "--no-auto-maintenance",
      "--no-recurse-submodules",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:${remoteRef}`,
    ],
    { ...options, timeoutMs: 60_000 },
  );
  if (fetched.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  options.signal?.throwIfAborted();
  const fetchSucceeded = fetched.termination === "exit" && fetched.code === 0;
  if (!fetchSucceeded) {
    warnings.push(commandError("git fetch origin default branch", fetched).message);
    branch = cachedBranch ?? branch;
    remoteRef = `refs/remotes/origin/${branch}`;
  }
  const verified = await runGit(
    repoRoot,
    ["rev-parse", "--verify", `${remoteRef}^{commit}`],
    options,
  );
  if (verified.termination !== "exit" || verified.code !== 0) {
    throw new Error(
      `Remote default ${remoteRef} is unavailable. Repair origin or choose an explicit worktree base ref. ${redactSensitiveText(warnings.join("\n"))}`,
    );
  }
  const commit = requireGitCommandOutput("git rev-parse remote default", verified).trim();
  if (fetchSucceeded && advertisedBranch && cachedBranch !== branch) {
    await requireGit(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", remoteRef], options);
  }
  return {
    branch,
    commit,
    gitOperand: remoteRef,
    recordRef: `origin/${branch}`,
    fetchSucceeded,
    ...(warnings.length ? { warning: redactSensitiveText(warnings.join("\n")) } : {}),
  };
}

class LocalDefaultBusyError extends Error {}

async function assertWorktreeGitOperationsIdle(
  repoRoot: string,
  localRef: string,
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<void> {
  const commonDir = path.resolve(
    repoRoot,
    normalizeGitPathForFilesystem(
      await requireGit(repoRoot, ["rev-parse", "--git-common-dir"], options),
    ),
  );
  try {
    const worktreesDir = path.join(commonDir, "worktrees");
    const worktrees = await fs.readdir(worktreesDir).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    });
    const busy = () =>
      new LocalDefaultBusyError(
        "Local default retained: finish or abort the Git rebase, am, or bisect operation reserving it before advancing it.",
      );
    const primary = await fs.readdir(commonDir);
    if (primary.some((name) => ["rebase-merge", "rebase-apply", "BISECT_LOG"].includes(name))) {
      throw busy();
    }
    const read = async (directory: string, name: string) =>
      await fs.readFile(path.join(directory, name), "utf8").catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
    // Rebase exec can reattach HEAD; reservations cannot be inferred from detached status.
    // Read only reservation files, with bounded I/O and no per-worktree directory listing.
    const checked = await runTasksWithConcurrency({
      limit: 16,
      errorMode: "stop",
      tasks: worktrees.map((name) => async () => {
        options.signal?.throwIfAborted();
        options.beforeRun?.();
        const directory = path.join(worktreesDir, name);
        for (const file of [
          "rebase-merge/head-name",
          "rebase-apply/head-name",
          "rebase-merge/update-refs",
        ]) {
          if ((await read(directory, file))?.trim().split("\n").includes(localRef)) {
            throw busy();
          }
        }
        const bisect = (await read(directory, "BISECT_START"))?.trim();
        if (bisect === localRef || bisect === localRef.slice("refs/heads/".length)) {
          if ((await read(directory, "BISECT_LOG")) !== undefined) {
            throw busy();
          }
        }
      }),
    });
    if (checked.hasError) {
      throw checked.firstError;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    options.beforeRun?.();
    if (error instanceof LocalDefaultBusyError) {
      throw error;
    }
    throw new LocalDefaultBusyError(
      "Local default retained: Git worktree operation state could not be checked. Inspect Git worktree metadata before retrying.",
      { cause: error },
    );
  }
}

async function fastForwardLocalDefault(
  repoRoot: string,
  branch: string,
  commit: string,
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<string | undefined> {
  const localRef = `refs/heads/${branch}`;
  const local = await runGit(repoRoot, ["rev-parse", "--verify", localRef], options);
  if (local.termination !== "exit" || local.code !== 0 || local.stdout.trim() === commit) {
    return undefined;
  }
  const previous = local.stdout.trim();
  const ancestor = await runGit(
    repoRoot,
    ["merge-base", "--is-ancestor", previous, commit],
    options,
  );
  if (ancestor.termination !== "exit" || ancestor.code !== 0) {
    return undefined;
  }
  const primary = await runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], options);
  if (primary.termination !== "exit" || primary.code !== 0 || primary.stdout.trim() !== localRef) {
    return undefined;
  }
  const advanced = await withWorktreeGitConfig(
    repoRoot,
    true,
    options,
    async (git) =>
      await git.run(
        repoRoot,
        ["merge", "--ff-only", "--no-edit", "--no-stat", "--no-overwrite-ignore", commit],
        {
          ...options,
          killProcessTree: true,
          startRun: async <T>(run: () => T): Promise<Awaited<T>> => {
            await assertWorktreeGitOperationsIdle(repoRoot, localRef, options);
            const checkouts = (await listGitWorktrees(repoRoot, options)).filter(
              (entry) => entry.branch === localRef,
            );
            const checkout = checkouts[0];
            if (
              !checkout ||
              checkouts.length > 1 ||
              path.resolve(checkout.path) !== path.resolve(repoRoot) ||
              checkout.lockedReason !== undefined
            ) {
              throw new LocalDefaultBusyError();
            }
            const sparse = await runGit(
              repoRoot,
              ["config", "--bool", "core.sparseCheckout"],
              options,
            );
            if (
              sparse.termination !== "exit" ||
              (sparse.code !== 0 && sparse.code !== 1) ||
              sparse.stdout.trim() === "true"
            ) {
              throw new LocalDefaultBusyError();
            }
            const dirty = await git.run(
              repoRoot,
              ["status", "--porcelain", "--untracked-files=all"],
              options,
            );
            if (dirty.termination !== "exit" || dirty.code !== 0 || dirty.stdout.trim()) {
              throw new LocalDefaultBusyError();
            }
            const current = await runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], options);
            if (
              current.termination !== "exit" ||
              current.code !== 0 ||
              current.stdout.trim() !== localRef
            ) {
              throw new LocalDefaultBusyError();
            }
            return await run();
          },
        },
      ),
  ).catch((error: unknown) => {
    if (error instanceof LocalDefaultBusyError) {
      return error;
    }
    throw error;
  });
  if (advanced instanceof LocalDefaultBusyError) {
    return advanced.message || undefined;
  }
  if (advanced.termination !== "exit" || advanced.code !== 0) {
    return commandError("git fast-forward local default", advanced).message;
  }
  return undefined;
}

/** Report the immutable commit captured by checkout registration, not an earlier ref value. */
export async function logWorktreeBase(
  repoRoot: string,
  base: ResolvedWorktreeBase,
  commit: string,
  context: {
    worktreePath: string;
    ownerId?: string;
    now: number;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
): Promise<void> {
  const committedAt = Number(
    await requireGit(
      repoRoot,
      ["show", "-s", "--no-show-signature", "--no-notes", "--format=%ct", commit],
      {
        signal: context.signal,
        beforeRun: context.assertCurrent,
        env: { GIT_NO_LAZY_FETCH: "1" },
      },
    ),
  );
  const ageDays = Math.max(0, (context.now / 1000 - committedAt) / 86_400);
  const stale = ageDays > 7;
  const message = `worktree base ${base.recordRef} at ${commit} (commit age ${ageDays.toFixed(1)} days; fetch ${base.fetchSucceeded === undefined ? "not requested" : base.fetchSucceeded ? "succeeded" : "failed"})${base.warning ? `: ${base.warning}` : ""}${stale ? "; base is older than 7 days. Check origin before starting work." : ""}`;
  const metadata = {
    worktreePath: context.worktreePath,
    ownerId: context.ownerId,
    baseRef: base.recordRef,
    baseCommit: commit,
    ageDays,
    fetchSucceeded: base.fetchSucceeded,
  };
  if (base.warning || stale) {
    log.warn(message, metadata);
  } else {
    log.info(message, metadata);
  }
}
