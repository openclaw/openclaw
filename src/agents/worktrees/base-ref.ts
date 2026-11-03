import fs from "node:fs/promises";
import path from "node:path";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { normalizeGitPathForFilesystem, requireGitCommandOutput } from "../../infra/git-exec.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { pathEntryExists } from "../../infra/path-existence.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  CommandProcessCleanupError,
  readCommandProcessFailure,
} from "../../process/exec-result.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { startWorktreeWait } from "./allocation.js";
import { estimateWorktreeGitBytes } from "./capacity.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import { commandError, listGitWorktrees, requireGit, runGit } from "./git.js";
import { fastForwardLocalDefault } from "./local-default.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";
import type { CreateManagedWorktreeParams, WorktreeWaitBudget } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

type ResolvedWorktreeBase = {
  commit: string;
  gitOperand: string;
  recordRef: string;
  noOrigin?: true;
  fetchSucceeded?: boolean;
  warning?: string;
  preparationKey?: string;
};

type RemoteDefaultAttempt = {
  pending: Promise<ResolvedWorktreeBase & { branch?: string }>;
  forwarded?: boolean;
  refreshedAt?: number;
  retired?: true;
};
type RemoteDefaultPreparation = { borrowers: number; attempt?: RemoteDefaultAttempt };
export type WorktreeBasePreparation = (options: {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  localDefault?: "preserve" | "fast-forward";
  waitBudget?: WorktreeWaitBudget;
}) => Promise<ResolvedWorktreeBase>;

const remoteDefaults = resolveGlobalMap<string, RemoteDefaultPreparation>(
  Symbol.for("openclaw.worktreeRemoteDefaults"),
);
const BASE_FRESHNESS_MS = 30_000;

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
    "baseRef" | "checkoutCommit" | "signal" | "commitGuard" | "onProgress"
  > & {
    prepareBase?: WorktreeBasePreparation;
    waitBudget?: WorktreeWaitBudget;
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
  if (!params.baseRef) {
    // Only the default-branch base fetches; pinned commits and explicit refs resolve locally.
    params.onProgress?.("base");
  }
  return params.prepareBase && !params.baseRef
    ? await params.prepareBase({
        signal: params.signal,
        assertCurrent: params.commitGuard,
        localDefault: "fast-forward",
        waitBudget: params.waitBudget,
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
      { signal, beforeRun: assertCurrent, env: { GIT_NO_LAZY_FETCH: "1" } },
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

/** A source owns remote transport; this owner verifies and advances only local Git state. */
export async function resolvePreparedWorktreeBase(
  repoRoot: string,
  base: { commit: string; ref: string },
  signal?: AbortSignal,
  assertCurrent?: () => void,
) {
  const verified = await resolveWorktreeBase(repoRoot, base.commit, signal, assertCurrent);
  const branch = /^origin\/(.+)$/u.exec(base.ref)?.[1];
  if (branch) {
    const options = {
      signal,
      beforeRun: assertCurrent,
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
    const warning = await fastForwardLocalDefault(
      { repoRoot, commonDir },
      branch,
      verified.commit,
      options,
    );
    if (warning) {
      log.warn(redactSensitiveText(warning));
    }
  }
  signal?.throwIfAborted();
  assertCurrent?.();
  return verified.commit;
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
  const cached = remoteDefaults.get(key);
  const shared: RemoteDefaultPreparation =
    cached &&
    ((cached.borrowers > 0 && cached.attempt?.refreshedAt === undefined) ||
      Date.now() - (cached.attempt?.refreshedAt ?? -Infinity) < BASE_FRESHNESS_MS)
      ? cached
      : { borrowers: 0 };
  shared.borrowers++;
  remoteDefaults.set(key, shared);
  pruneMapToMaxSize(remoteDefaults, 32);
  let active = true;
  const resolutions: Promise<ResolvedWorktreeBase>[] = [];
  const resolve: WorktreeBasePreparation = async ({
    signal,
    assertCurrent,
    localDefault = "preserve",
    waitBudget,
  }) => {
    let retirement: { error: unknown } | undefined;
    let waiting: ReturnType<typeof startWorktreeWait> | undefined;
    const options = {
      signal,
      beforeRun: () => {
        try {
          if (!active) {
            throw new Error("Worktree base preparation is closed");
          }
          options.signal?.throwIfAborted();
          assertCurrent?.();
        } catch (error) {
          retirement = { error };
          throw error;
        }
      },
      env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    };
    const settled = (attempt: RemoteDefaultAttempt, pending: RemoteDefaultAttempt["pending"]) =>
      pending.catch((error: unknown) => {
        attempt.refreshedAt = undefined;
        if (hasWorktreeUnknownOutcome(error)) {
          throw error;
        }
        const outcome = readCommandProcessFailure(error);
        if (outcome?.cleanup === "uncertain") {
          throw new CommandProcessCleanupError({ cause: error });
        }
        // Only this phase owner's actual authority failure can retire its attempt.
        // Normal signal cleanup includes cancellation before spawn or during Git's
        // retry delay; stopped children also require the runner's abort receipt.
        // A concurrent cancellation must not turn an unrelated Git error into a retry.
        if (
          (retirement && retirement.error === error) ||
          (options.signal?.aborted &&
            (error === options.signal.reason ||
              (outcome?.termination === "signal" &&
                !outcome.outputLimitExceeded &&
                (outcome.cleanup === "normal" ||
                  (outcome.killIssuedByAbort === true &&
                    (outcome.cleanup === "cooperative" || outcome.cleanup === "forced"))))))
        ) {
          attempt.retired = true;
        }
        throw error;
      });
    try {
      for (;;) {
        options.beforeRun();
        let attempt = shared.attempt;
        let ownsAttempt = false;
        if (!attempt) {
          ownsAttempt = true;
          const started: RemoteDefaultAttempt = {
            pending: timeWorktreePreparationPhase("baseRefresh", () =>
              prepareDefaultBase(repository, options),
            ).then(async (base) => {
              // Immutable commits share hydration across refreshes while the Git worker lives.
              const preparationKey = base.commit;
              await timeWorktreePreparationPhase("baseHydration", () =>
                estimateWorktreeGitBytes(repository.repoRoot, base.commit, {
                  signal: options.signal,
                  assertCurrent: options.beforeRun,
                  preparationKey,
                }),
              );
              base.preparationKey = preparationKey;
              options.beforeRun();
              if (base.fetchSucceeded) {
                started.refreshedAt = Date.now();
              }
              return base;
            }),
          };
          started.pending = settled(started, started.pending);
          attempt = shared.attempt = started;
        }
        if (localDefault === "fast-forward" && !attempt.forwarded) {
          ownsAttempt = true;
          attempt.forwarded = true;
          attempt.pending = settled(
            attempt,
            attempt.pending.then(async (base) => {
              const { branch } = base;
              const warning = branch
                ? await timeWorktreePreparationPhase("baseFastForward", () =>
                    fastForwardLocalDefault(repository, branch, base.commit, options),
                  )
                : undefined;
              return warning
                ? {
                    ...base,
                    warning: [base.warning, redactSensitiveText(warning)]
                      .filter(Boolean)
                      .join("\n"),
                  }
                : base;
            }),
          );
        }
        try {
          const selected = await timeWorktreePreparationPhase("baseWait", () =>
            waiting && !ownsAttempt
              ? racePromiseWithAbortSignal(
                  attempt.pending,
                  options.signal,
                  (aborted) => aborted.reason,
                )
              : attempt.pending,
          );
          options.beforeRun();
          const { branch: _branch, ...base } = selected;
          return base;
        } catch (error) {
          if (!attempt.retired || hasWorktreeUnknownOutcome(error)) {
            throw error;
          }
          options.beforeRun();
          if (!waiting) {
            // Exceptional recovery consumes one remaining creation-wait interval,
            // including every replacement; native work still owns its settlement.
            waiting = startWorktreeWait(waitBudget);
            if (waiting.waitMs === 0) {
              throw new Error(
                "Workspace creation timed out waiting for repository preparation. Retry creating the workspace.",
                { cause: error },
              );
            }
            const deadline = AbortSignal.timeout(waiting.waitMs);
            options.signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
          }
          // A later borrower may already have replaced exactly this settled attempt.
          if (shared.attempt === attempt) {
            shared.attempt = undefined;
          }
        }
      }
    } finally {
      waiting?.end();
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
    await Promise.allSettled(resolutions);
    if (
      --shared.borrowers === 0 &&
      !shared.attempt?.refreshedAt &&
      remoteDefaults.get(key) === shared
    ) {
      remoteDefaults.delete(key);
    }
  }
}

async function hasOriginDestination(
  { repoRoot, commonDir }: { repoRoot: string; commonDir: string },
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<boolean> {
  // Options such as inherited origin.prune enumerate a remote without giving it a destination.
  // Presence preserves explicit empty URLs and helper configuration for Git's existing errors.
  const configured = await runGit(
    repoRoot,
    ["config", "--name-only", "--get-regexp", "^remote\\.origin\\.(url|pushurl|vcs)$"],
    options,
  );
  if (configured.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (configured.termination !== "exit" || configured.code !== 1) {
    requireGitCommandOutput("git config origin destination", configured);
    return true;
  }
  const destination = await runGit(repoRoot, ["ls-remote", "--get-url", "origin"], options);
  if (destination.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  const resolved = requireGitCommandOutput("git ls-remote --get-url origin", destination);
  // This command performs no network access. Git still owns legacy records and URL rewrites.
  if (resolved !== "origin\n" && resolved !== "origin\r\n") {
    return true;
  }
  // Git also accepts a relative path named origin. Keep existing or malformed legacy
  // destinations on the remote path even when Git resolves their operand to origin.
  for (const target of [
    path.join(repoRoot, "origin"),
    path.join(commonDir, "remotes", "origin"),
    path.join(commonDir, "branches", "origin"),
  ]) {
    if (await pathEntryExists(target)) {
      return true;
    }
  }
  return false;
}

async function prepareDefaultBase(
  repository: { repoRoot: string; commonDir: string },
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<ResolvedWorktreeBase & { branch?: string }> {
  const { repoRoot } = repository;
  const remotes = await requireGit(repoRoot, ["remote"], options);
  if (remotes.split("\n").includes("origin") && (await hasOriginDestination(repository, options))) {
    return await fetchRemoteDefault(repoRoot, options);
  }
  const primary = (await listGitWorktrees(repoRoot, options))[0]?.path ?? repoRoot;
  const commit = await requireGit(primary, ["rev-parse", "--verify", "HEAD^{commit}"], options);
  return { commit, gitOperand: commit, recordRef: "HEAD", noOrigin: true };
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
  if (cached.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  const advertised = await runGit(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"], {
    ...options,
    timeoutMs: 30_000,
  });
  if (advertised.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (options.signal?.aborted) {
    requireGitCommandOutput("git ls-remote origin HEAD", advertised);
    options.signal.throwIfAborted();
  }
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
  if (options.signal?.aborted) {
    requireGitCommandOutput("git fetch origin default branch", fetched);
    options.signal.throwIfAborted();
  }
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
  if (verified.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (options.signal?.aborted) {
    requireGitCommandOutput("git rev-parse remote default", verified);
    options.signal.throwIfAborted();
  }
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
  const label = base.noOrigin ? "local HEAD (no origin remote)" : base.recordRef;
  const staleHint = `; base is older than 7 days. Check ${base.noOrigin ? "local HEAD" : "origin"} before starting work.`;
  const message = `worktree base ${label} at ${commit} (commit age ${ageDays.toFixed(1)} days; fetch ${base.fetchSucceeded === undefined ? "not requested" : base.fetchSucceeded ? "succeeded" : "failed"})${base.warning ? `: ${base.warning}` : ""}${stale ? staleHint : ""}`;
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
