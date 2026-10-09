import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  createGitCommandError,
  enqueueGitRefMutation,
  executeGitCommand,
  executeGitCommandBytes,
  executeGitCommandBuffered,
  normalizeGitPathForFilesystem,
  requireGitCommandOutput,
  type GitBufferedCommandOptions,
  type GitCommandOptions,
} from "../../infra/git-exec.js";
import { withGitRepositoryRepair } from "../../infra/git-repository-repair.js";
import { hasGitWorkerContext, requestGitWorkerCommand } from "../../infra/git-worker-context.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../../infra/process-env.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../../infra/windows-encoding.js";
import type { BufferedCommandResult } from "../../process/exec.js";

export type GitResult = Awaited<ReturnType<typeof executeGitCommand>>;

// Materializing checkout objects gets extra time without extending other Git commands or setup.
export const WORKTREE_CHECKOUT_TIMEOUT_MS = 300_000;
const REPAIRABLE_FETCH_FLAGS = new Set([
  "--no-auto-maintenance",
  "--refetch",
  "--no-tags",
  "--no-write-fetch-head",
  "--no-recurse-submodules",
  "--recurse-submodules=no",
  "--stdin",
  "--prune",
  "--no-prune",
]);

type WorktreeListEntry = {
  path: string;
  head?: string;
  lockedReason?: string;
  branch?: string | null;
};

function withNoGlob(value: string | undefined): string {
  if (value?.trim().split(/\s+/).at(-1) === "noglob") {
    return value;
  }
  return value ? `${value} noglob` : "noglob";
}

/**
 * Gateway-run Git must never execute repository hooks or filesystem monitors;
 * the admin-gated setup script is the sole intentional repository-code path.
 * Exported so other Gateway-owned callers that must bypass the `runGit`/
 * `requireGit*` wrappers (e.g. a buffered, non-throwing invocation with a
 * custom timeout) still pin the same invariant instead of reimplementing it.
 */
export function gitEnvironment(
  env?: NodeJS.ProcessEnv,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const baseEnv = env ?? inheritedEnv;
  // Callers may supply only Git-specific overrides. Resolve against the inherited
  // child environment first so preserving revision arguments cannot discard policy.
  const effectiveWindowsEnv =
    platform === "win32" && args.some((arg) => arg.endsWith("^{commit}"))
      ? mergeProcessEnv([inheritedEnv, env], platform)
      : undefined;
  const windowsNoGlob = effectiveWindowsEnv
    ? {
        // MSYS2/Cygwin expand braces before Git sees argv. Keep revision
        // expressions such as HEAD^{commit} literal within this Git owner.
        MSYS: withNoGlob(resolveEnvironmentValue(effectiveWindowsEnv, "MSYS", platform)),
        CYGWIN: withNoGlob(resolveEnvironmentValue(effectiveWindowsEnv, "CYGWIN", platform)),
      }
    : {};
  return {
    ...baseEnv,
    ...windowsNoGlob,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: os.devNull,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
}

export async function runGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitResult> {
  if (hasGitWorkerContext()) {
    const { signal: _signal, beforeRun: _beforeRun, ...forwarded } = options;
    const result = await requestGitWorkerCommand({
      type: "git.text",
      input: { cwd, args, options: forwarded },
    });
    const { stdout, stderr, windowsEncoding, ...metadata } = result;
    return {
      ...metadata,
      stdout: decodeWindowsOutputBuffer({
        buffer: Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength),
        windowsEncoding,
      }),
      stderr: decodeWindowsOutputBuffer({
        buffer: Buffer.from(stderr.buffer, stderr.byteOffset, stderr.byteLength),
        windowsEncoding,
      }),
    };
  }
  return await runOwnedGitCommand(cwd, args, options, executeGitCommand);
}

/** Parent-only command execution for text consumers whose decoding runs in a worker. */
export async function runGitBytes(
  cwd: string,
  args: string[],
  options: Parameters<typeof runGit>[2] = {},
) {
  return await runOwnedGitCommand(cwd, args, options, executeGitCommandBytes);
}

async function runOwnedGitCommand<
  T extends {
    termination: string;
    code: number | null;
    stdout: string | Uint8Array;
    stderr: string | Uint8Array;
  },
>(
  cwd: string,
  args: string[],
  options: GitCommandOptions,
  execute: (cwd: string, args: string[], options: GitCommandOptions) => Promise<T>,
): Promise<T> {
  const baseEnv = options.baseEnv ?? { ...process.env };
  const env = gitEnvironment(options.env, args, process.platform, baseEnv);
  return await withGitRefAdmission(
    cwd,
    args,
    async (gitArgs) => {
      const run = () =>
        execute(cwd, gitArgs, {
          ...options,
          beforeRun: gitArgs === args ? options.beforeRun : undefined,
          baseEnv,
          env,
          input: gitArgs === args ? options.input : undefined,
          // Fetch can prune refs and start maintenance; keep its follow-on writes owned.
          killProcessTree: options.killProcessTree ?? (args[0] === "fetch" && gitArgs === args),
        });
      const result = await run();
      if (gitArgs !== args || args[0] !== "fetch" || result.code !== 128) {
        return result;
      }
      // Admit our origin fetches, including the default-branch owner's canonical refspec.
      // Unknown option values (such as --server-option origin) cannot select a remote.
      const [remote, refspec, ...extra] = args
        .slice(1)
        .filter((arg) => !REPAIRABLE_FETCH_FLAGS.has(arg));
      if (
        remote !== "origin" ||
        extra.length > 0 ||
        (refspec !== undefined && !/^\+refs\/heads\/(.+):refs\/remotes\/origin\/\1$/u.test(refspec))
      ) {
        return result;
      }
      return await withGitRepositoryRepair({
        cwd,
        result,
        remote: "origin",
        pruneTracking: !args.includes("--no-prune"),
        signal: options.signal,
        assertCurrent: options.beforeRun,
        retry: run,
        run: (repairArgs, repairOptions) =>
          executeGitCommand(cwd, repairArgs, {
            ...options,
            ...repairOptions,
            baseEnv,
            env: { ...env, ...repairOptions.env },
          }),
      });
    },
    options.signal,
    options.refMutationDirectory,
  );
}

async function withGitRefAdmission<
  T extends { termination: string; code: number | null; stdout: string | Uint8Array },
>(
  cwd: string,
  args: string[],
  run: (args: string[]) => Promise<T>,
  signal?: AbortSignal,
  refMutationDirectory?: string,
): Promise<T> {
  const mutatesRefs =
    args[0] === "fetch" ||
    args[0] === "update-ref" ||
    args[0] === "merge" ||
    (args[0] === "worktree" && args[1] === "add" && !args.includes("--detach")) ||
    (args[0] === "symbolic-ref" && args.length === 3 && !args[1]?.startsWith("-")) ||
    (args[0] === "branch" &&
      args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete"));
  if (!mutatesRefs) {
    return await run(args);
  }
  let commonDir = refMutationDirectory;
  if (!commonDir) {
    const resolved = await run(["rev-parse", "--git-common-dir"]);
    if (resolved.termination !== "exit" || resolved.code !== 0) {
      return resolved;
    }
    commonDir =
      typeof resolved.stdout === "string"
        ? resolved.stdout
        : decodeWindowsOutputBuffer({
            buffer: Buffer.from(
              resolved.stdout.buffer,
              resolved.stdout.byteOffset,
              resolved.stdout.byteLength,
            ),
            windowsEncoding: resolveWindowsConsoleEncoding(),
          });
  }
  let entered = false;
  try {
    return await enqueueGitRefMutation(
      cwd,
      commonDir.trim(),
      () => {
        entered = true;
        return run(args);
      },
      signal,
    );
  } catch (error) {
    if (!entered && signal?.aborted && error === signal.reason) {
      // The runner owns cancellation results and returns before spawning with this signal.
      return await run(args);
    }
    throw error;
  }
}

/** Byte-preserving Git transport shared by worker inventories and ordinary callers. */
export async function runGitBuffered(
  cwd: string,
  args: string[],
  options: GitBufferedCommandOptions = {},
): Promise<BufferedCommandResult> {
  if (hasGitWorkerContext()) {
    const { signal: _signal, beforeRun: _beforeRun, ...forwarded } = options;
    const result = await requestGitWorkerCommand({
      type: "git.buffer",
      input: { cwd, args, options: forwarded },
    });
    return {
      ...result,
      stdout: Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength),
      stderr: Buffer.from(result.stderr.buffer, result.stderr.byteOffset, result.stderr.byteLength),
    };
  }
  const baseEnv = options.baseEnv ?? { ...process.env };
  const env = gitEnvironment(options.env, args, process.platform, baseEnv);
  return await withGitRefAdmission(
    cwd,
    args,
    (gitArgs) => {
      return executeGitCommandBuffered(cwd, gitArgs, {
        ...options,
        beforeRun: gitArgs === args ? options.beforeRun : undefined,
        input: gitArgs === args ? options.input : undefined,
        baseEnv,
        env,
      });
    },
    options.signal,
    options.refMutationDirectory,
  );
}

export { createGitCommandError as commandError } from "../../infra/git-exec.js";

export async function requireGit(
  cwd: string,
  args: string[],
  options: Parameters<typeof runGit>[2] = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  return requireGitCommandOutput(`git ${args.join(" ")}`, result).trim();
}

export async function requireGitBuffer(
  cwd: string,
  args: string[],
  options: Parameters<typeof runGitBuffered>[2] = {},
): Promise<Buffer> {
  const result = await runGitBuffered(cwd, args, options);
  if (result.termination !== "exit" || result.code !== 0) {
    throw createGitCommandError(`git ${args.join(" ")}`, result);
  }
  return result.stdout;
}

/** Git may return relative or Windows-native spellings for its administrative paths. */
export async function resolveGitMetadataPath(
  cwd: string,
  name: string,
  options: GitCommandOptions = {},
): Promise<string> {
  return path.resolve(
    cwd,
    normalizeGitPathForFilesystem(
      await requireGit(cwd, ["rev-parse", "--git-path", name], options),
    ),
  );
}

function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) {
        entries.push(current);
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = {
        path: normalizeGitPathForFilesystem(field.slice("worktree ".length)),
      };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (current && field === "locked") {
      current.lockedReason = "";
    } else if (current && field.startsWith("locked ")) {
      current.lockedReason = field.slice("locked ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    } else if (current && field === "detached") {
      current.branch = null;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export async function listGitWorktrees(
  repoRoot: string,
  options: Parameters<typeof runGit>[2] = {},
): Promise<WorktreeListEntry[]> {
  return parseWorktreeList(
    requireGitCommandOutput(
      "git worktree list",
      await runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"], options),
    ),
  );
}

/** Resolve shared storage and its primary root without selecting or validating HEAD. */
export async function resolveGitRepositoryPaths(
  sourceRoot: string,
  options: Parameters<typeof runGit>[2] = {},
): Promise<{ canonicalRoot: string; commonDir: string }> {
  const commonRaw = normalizeGitPathForFilesystem(
    await requireGit(sourceRoot, ["rev-parse", "--git-common-dir"], options),
  );
  const commonDir = await fs.realpath(path.resolve(sourceRoot, commonRaw));
  const primary = (await listGitWorktrees(sourceRoot, options))[0]?.path ?? sourceRoot;
  const canonicalRoot = await fs.realpath(primary);
  return { canonicalRoot, commonDir };
}

/**
 * True when dir sits inside a git checkout: a .git entry on itself or any ancestor.
 * Existence, not directory-ness, is the signal — linked worktrees keep a .git file.
 * Mirrors `git rev-parse --show-toplevel` discovery without spawning git, so UI
 * capability checks and create-preflights cannot diverge from the worktree service.
 */
export function findGitCheckoutRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function insideGitCheckout(start: string): boolean {
  return findGitCheckoutRoot(start) !== null;
}

export async function hasSelfContainedGitMetadata(checkoutRoot: string): Promise<boolean> {
  return (await lstatIfExists(path.join(checkoutRoot, ".git")))?.isDirectory() ?? false;
}

export async function worktreePathExists(target: string): Promise<boolean> {
  return (await lstatIfExists(target)) !== undefined;
}

export async function lstatIfExists(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}
