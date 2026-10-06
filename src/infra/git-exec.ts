import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createCommandError } from "../process/command-error.js";
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandBuffersWithTimeout, type BufferSpawnResult } from "../process/exec-runner.js";
import {
  runCommandWithTimeout,
  runCommandBuffered,
  type BufferedCommandOptions,
  type BufferedCommandResult,
  type CommandOptions,
} from "../process/exec.js";
import { withGitProcessOperation, type GitProcessOperation } from "../process/spawn-diagnostics.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  retryableGitNetworkOperation,
  withGitNetworkRetry,
  type GitOperationStarter,
} from "./git-network-retry.js";
import { startGitOperationTiming } from "./git-operation-timing.js";

export const GIT_TIMEOUT_MS = 120_000;

export class GitCommandTimeoutError extends Error {
  override name = "GitCommandTimeoutError";
}

// Keep live writers ordered across runtime chunks and shutdown. Settled tails
// remove themselves; resetting this queue would release already-owned cleanup.
const gitRefMutations = resolveGlobalSingleton(
  Symbol.for("openclaw.gitRefMutations"),
  () => new KeyedAsyncQueue(),
);
const refMutationLog = createSubsystemLogger("git/ref-mutation");

export async function enqueueGitRefMutation<T>(
  cwd: string,
  commonDirectory: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timing = startGitOperationTiming("ref-mutation", refMutationLog);
  let outcome: "returned" | "threw" = "threw";
  const admitted = { run, signal, timing, completion: createDeferredCore<T>() };
  let waiting: typeof admitted | undefined = admitted;
  const abort = () => {
    const cancelled = waiting;
    waiting = undefined;
    cancelled?.completion.reject(cancelled.signal?.reason);
  };
  try {
    signal?.throwIfAborted();
    const commonPath = normalizeGitPathForFilesystem(commonDirectory);
    const commonDir = await fs.realpath(path.resolve(cwd, commonPath));
    signal?.throwIfAborted();
    const key = process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
    // Even deleting a loose ref locks shared packed-refs. Queue every ref owner
    // across linked worktrees; external contention retains its native error.
    timing?.markPhase();
    signal?.addEventListener("abort", abort, { once: true });
    const queued = gitRefMutations.enqueue(key, async () => {
      // Cancellation drops the entire caller, including its rejected promise and reason.
      // Once started, the process owner must finish cleanup before we settle.
      const active = waiting;
      waiting = undefined;
      if (!active) {
        return;
      }
      try {
        active.signal?.removeEventListener("abort", abort);
        active.timing?.markPhase();
        active.completion.resolve(await active.run());
      } catch (error) {
        active.completion.reject(error);
      }
    });
    void queued.catch((error: unknown) => waiting?.completion.reject(error));
    const result = await admitted.completion.promise;
    outcome = "returned";
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    timing?.finish(outcome);
  }
}

type GitCommandResult = SpawnResult & { timeoutMs: number };

export function normalizeGitPathForFilesystem(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return value;
  }
  // Translate only path-typed Git output at its filesystem boundary. Native
  // paths must stay untouched because C:\c\... can be a real Windows path.
  const match = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(value);
  const drive = match?.[1];
  if (!drive) {
    return value;
  }
  return path.win32.normalize(`${drive.toUpperCase()}:/${match[2] ?? ""}`);
}

export function gitCommandArgv(cwd: string, args: string[], config: string[] = []): string[] {
  return [
    "git",
    ...config.flatMap((value) => ["-c", value]),
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
    "-C",
    cwd,
    ...args,
  ];
}

function gitExecutionArgv(
  cwd: string,
  args: string[],
  options: { killProcessTree?: boolean; lowerPriority?: boolean },
): string[] {
  // Maintenance and legacy auto-GC must stay in their cancellable process tree.
  const argv = gitCommandArgv(
    cwd,
    args,
    options.killProcessTree ? ["maintenance.autoDetach=false", "gc.autoDetach=false"] : [],
  );
  return options.lowerPriority && process.platform !== "win32"
    ? ["nice", "-n", "10", ...argv]
    : argv;
}

export type GitCommandOptions = Pick<
  CommandOptions,
  | "timeoutMs"
  | "baseEnv"
  | "env"
  | "input"
  | "signal"
  | "killProcessTree"
  | "killGraceMs"
  | "maxOutputBytes"
  | "terminateOnOutputLimit"
> & {
  /** Yield CPU to foreground Gateway work for content-heavy background reads. */
  lowerPriority?: boolean;
  operation?: GitProcessOperation;
  /** An admitted destructive operation must settle without the generic Git deadline. */
  waitForExit?: boolean;
  /** Recheck caller authority immediately before each attempt. */
  beforeRun?: () => void;
  /** Admit each attempt inside the caller's asynchronous credential owner. */
  startRun?: GitOperationStarter;
};
export type GitCommandBytesResult = BufferSpawnResult & { timeoutMs: number };

export async function executeGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  return withGitProcessOperation(options.operation, () =>
    executeGitCommandWithOutput(runCommandWithTimeout, cwd, args, options),
  );
}

/** The same command/timeout contract, with output bytes owned by a worker consumer. */
export async function executeGitCommandBytes(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandBytesResult> {
  return withGitProcessOperation(options.operation, () =>
    executeGitCommandWithOutput(runCommandBuffersWithTimeout, cwd, args, options),
  );
}

async function executeGitCommandWithOutput<Result extends SpawnResult | BufferSpawnResult>(
  run: (argv: string[], options: CommandOptions) => Promise<Result>,
  cwd: string,
  args: string[],
  options: GitCommandOptions,
): Promise<Result & { timeoutMs: number }> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const argv = gitExecutionArgv(cwd, args, options);
  if (options.waitForExit === true) {
    const start = () => {
      options.beforeRun?.();
      return run(argv, {
        ...options,
        timeoutMs: undefined,
      });
    };
    const result = await (options.startRun ? options.startRun(start) : start());
    return { ...result, timeoutMs: 0 };
  }
  const result = await withGitNetworkRetry(
    retryableGitNetworkOperation(args),
    { ...options, timeoutMs },
    (attemptTimeoutMs) =>
      run(argv, {
        ...options,
        timeoutMs: attemptTimeoutMs,
      }),
  );
  return { ...result, timeoutMs };
}

export type GitBufferedCommandOptions = BufferedCommandOptions & {
  lowerPriority?: boolean;
  beforeRun?: () => void;
  startRun?: GitOperationStarter;
  operation?: GitProcessOperation;
};

export async function executeGitCommandBuffered(
  cwd: string,
  args: string[],
  options: GitBufferedCommandOptions = {},
): Promise<BufferedCommandResult> {
  const argv = gitExecutionArgv(cwd, args, {
    ...options,
    killProcessTree: options.killProcessTree !== false,
  });
  return await withGitProcessOperation(options.operation, () =>
    withGitNetworkRetry(
      retryableGitNetworkOperation(args),
      { ...options, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS },
      (timeoutMs) => runCommandBuffered(argv, { ...options, timeoutMs }),
    ),
  );
}

export function createGitCommandError(
  command: string,
  result: (SpawnResult | BufferedCommandResult) & { timeoutMs?: number },
): Error {
  // Buffered Git uses the fixed default; text results carry their applied budget.
  const timeoutMs = result.timeoutMs ?? GIT_TIMEOUT_MS;
  const error = createCommandError(command, result, {
    timeoutMs,
  });
  if (result.termination === "timeout") {
    return new GitCommandTimeoutError(
      `${error.message}\nGit did not finish within its ${timeoutMs / 1000}s budget; check remote reachability, repository locks, and clone shape (partial clones fetch missing objects lazily).`,
    );
  }
  return error;
}

export async function requireGitCommand(
  cwd: string,
  args: string[],
  options: Pick<GitCommandOptions, "env" | "input" | "timeoutMs" | "operation"> = {},
): Promise<string> {
  return requireGitCommandOutput(
    `git ${args.join(" ")}`,
    await executeGitCommand(cwd, args, options),
  ).trim();
}

export function requireGitCommandOutput(
  command: string,
  result: GitCommandResult,
  createError: (command: string, result: GitCommandResult) => Error = createGitCommandError,
): string {
  if (result.termination !== "exit" || result.code !== 0) {
    throw createError(command, result);
  }
  // Required stdout is data, not a diagnostic tail; a clean exit cannot make it complete.
  if (result.stdoutTruncatedBytes) {
    throw createError(command, { ...result, code: null, outputLimitExceeded: true });
  }
  return result.stdout;
}

// Git config filenames need "NUL" on Windows; os.devNull's device path is invalid.
// Config values such as core.hooksPath still accept os.devNull.
export function gitNullConfigPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}
