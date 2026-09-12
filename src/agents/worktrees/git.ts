import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createGitCommandError,
  GIT_TIMEOUT_MS,
  enqueueGitRefMutation,
  executeGitCommand,
  executeGitCommandBytes,
  normalizeGitPathForFilesystem,
  requireGitCommandOutput,
  withForegroundGitMaintenance,
  type GitCommandOptions,
} from "../../infra/git-exec.js";
import { hasGitWorkerContext, requestGitWorkerCommand } from "../../infra/git-worker-context.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../../infra/process-env.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../../infra/windows-encoding.js";
import {
  runCommandBuffered,
  type BufferedCommandOptions,
  type BufferedCommandResult,
} from "../../process/exec.js";

export type GitResult = Awaited<ReturnType<typeof executeGitCommand>>;

// Materializing checkout objects gets extra time without extending other Git commands or setup.
export const WORKTREE_CHECKOUT_TIMEOUT_MS = 300_000;

type WorktreeListEntry = {
  path: string;
  lockedReason?: string;
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
  options: GitCommandOptions & {
    /** Recheck caller authority at execution, after any shared-ref queue wait. */
    beforeRun?: () => void;
  } = {},
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
  const baseEnv = options.baseEnv ?? { ...process.env };
  const env = gitEnvironment(options.env, args, process.platform, baseEnv);
  // Fetch can prune refs and start maintenance; keep its follow-on writes owned.
  const fetchesRefs = args[0] === "fetch";
  const run = (gitArgs: string[]) => {
    if (gitArgs === args) {
      options.beforeRun?.();
    }
    return executeGitCommand(cwd, gitArgs, {
      ...options,
      baseEnv,
      env,
      input: gitArgs === args ? options.input : undefined,
      killProcessTree: options.killProcessTree ?? (fetchesRefs && gitArgs === args),
    });
  };
  return await withGitRefAdmission(cwd, args, run);
}

/** Parent-only command execution for text consumers whose decoding runs in a worker. */
export async function runGitBytes(
  cwd: string,
  args: string[],
  options: Parameters<typeof runGit>[2] = {},
) {
  const baseEnv = options.baseEnv ?? { ...process.env };
  const env = gitEnvironment(options.env, args, process.platform, baseEnv);
  return await withGitRefAdmission(cwd, args, (gitArgs) => {
    if (gitArgs === args) {
      options.beforeRun?.();
    }
    return executeGitCommandBytes(cwd, gitArgs, {
      ...options,
      baseEnv,
      env,
      input: gitArgs === args ? options.input : undefined,
      killProcessTree: options.killProcessTree ?? (args[0] === "fetch" && gitArgs === args),
    });
  });
}

async function withGitRefAdmission<
  T extends { termination: string; code: number | null; stdout: string | Uint8Array },
>(cwd: string, args: string[], run: (args: string[]) => Promise<T>): Promise<T> {
  const mutatesRefs =
    args[0] === "fetch" ||
    args[0] === "update-ref" ||
    (args[0] === "branch" &&
      args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete"));
  if (!mutatesRefs) {
    return await run(args);
  }
  const resolved = await run(["rev-parse", "--git-common-dir"]);
  if (resolved.termination !== "exit" || resolved.code !== 0) {
    return resolved;
  }
  const commonDir =
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
  return await enqueueGitRefMutation(cwd, commonDir.trim(), () => run(args));
}

/** Byte-preserving Git transport shared by worker inventories and ordinary callers. */
export async function runGitBuffered(
  cwd: string,
  args: string[],
  options: BufferedCommandOptions & { beforeRun?: () => void } = {},
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
  return await withGitRefAdmission(cwd, args, (gitArgs) => {
    if (gitArgs === args) {
      options.beforeRun?.();
    }
    const argv = ["git", "-C", cwd, ...gitArgs];
    return runCommandBuffered(
      options.killProcessTree === false ? argv : withForegroundGitMaintenance(argv),
      {
        ...options,
        timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
        input: gitArgs === args ? options.input : undefined,
        baseEnv,
        env,
      },
    );
  });
}

export function commandError(command: string, result: GitResult): Error {
  return createGitCommandError(command, result);
}

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
    } else if (current && field === "locked") {
      current.lockedReason = "";
    } else if (current && field.startsWith("locked ")) {
      current.lockedReason = field.slice("locked ".length);
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
  const commonDir = await fs.realpath(
    path.isAbsolute(commonRaw) ? commonRaw : path.resolve(sourceRoot, commonRaw),
  );
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
  try {
    const marker = await fs.lstat(path.join(checkoutRoot, ".git"));
    return marker.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function worktreePathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
