import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createCommandError } from "../process/command-error.js";
import { recordCommandProcessFailure, type SpawnResult } from "../process/exec-result.js";
import type { BufferSpawnResult } from "../process/exec-runner.js";
import type {
  BufferedCommandOptions,
  BufferedCommandResult,
  CommandOptions,
} from "../process/exec.js";
import { withGitProcessOperation, type GitProcessOperation } from "../process/spawn-diagnostics.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  gitCommandName,
  retryableGitNetworkOperation,
  withGitNetworkRetry,
  type GitOperationStarter,
} from "./git-network-retry.js";
import { startGitOperationTiming } from "./git-operation-timing.js";
import { decodeWindowsOutputBuffer } from "./windows-encoding.js";

export const GIT_TIMEOUT_MS = 120_000;

/** Inspection consumes local objects; only explicit transfers may hydrate a partial clone. */
export function gitReadOnlyEnvironment(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const command = gitCommandName(args);
  return command &&
    (/^(?:cat-file|check-attr|check-ignore|config|describe|diff|diff-files|diff-index|diff-tree|for-each-ref|log|ls-files|ls-tree|merge-base|name-rev|rev-list|rev-parse|show|show-ref|status)$/.test(
      command,
    ) ||
      (command === "worktree" && args[args.indexOf(command) + 1] === "list") ||
      (command === "branch" && args.includes("--list")))
    ? { ...env, GIT_NO_LAZY_FETCH: "1" }
    : env;
}

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
  | "noOutputTimeoutMs"
  | "baseEnv"
  | "env"
  | "input"
  | "signal"
  | "killProcessTree"
  | "killGraceMs"
  | "maxOutputBytes"
  | "terminateOnOutputLimit"
> & {
  /** Canonical ref owner when content commands use a temporary safe configuration view. */
  refMutationDirectory?: string;
  /** Yield CPU to foreground Gateway work for content-heavy background reads. */
  lowerPriority?: boolean;
  /** Drain a bounded file inventory's patches, keeping this many bytes plus an overflow marker per file. */
  maxPatchBytes?: number;
  operation?: GitProcessOperation;
  /** Settle without the generic absolute deadline; an idle deadline may still apply. */
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
  const { runCommandWithTimeout } = await import("../process/exec.js");
  return withGitProcessOperation(options.operation, () =>
    executeGitCommandWithOutput(
      runCommandWithTimeout,
      (result, stdout) => ({ ...result, stdout: decodeWindowsOutputBuffer({ buffer: stdout }) }),
      cwd,
      args,
      options,
    ),
  );
}

/** The same command/timeout contract, with output bytes owned by a worker consumer. */
export async function executeGitCommandBytes(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandBytesResult> {
  const { runCommandBuffersWithTimeout } = await import("../process/exec-runner.js");
  return withGitProcessOperation(options.operation, () =>
    executeGitCommandWithOutput(
      runCommandBuffersWithTimeout,
      (result, stdout) => ({ ...result, stdout }),
      cwd,
      args,
      options,
    ),
  );
}

function createGitPatchCapture(maxPatchBytes: number) {
  const separator = Buffer.from("\ndiff --git ");
  const chunks: Buffer[] = [];
  let pending = Buffer.alloc(0);
  let captured = 0;
  let lastByte: number | undefined;
  const append = (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, maxPatchBytes + 1 - captured));
    if (kept.length > 0) {
      chunks.push(Buffer.from(kept));
      captured += kept.length;
      lastByte = kept[kept.length - 1];
    }
  };
  const finishPatch = () => {
    // Keep clipped frames separable while their extra byte makes truncation explicit.
    if (captured > maxPatchBytes && lastByte !== 10) {
      chunks.push(Buffer.from("\n"));
    }
    captured = 0;
    lastByte = undefined;
  };
  return {
    append(chunk: Buffer) {
      const input = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      let boundary = input.indexOf(separator);
      while (boundary !== -1) {
        append(input.subarray(start, boundary + 1));
        finishPatch();
        start = boundary + 1;
        boundary = input.indexOf(separator, start);
      }
      // A header can straddle process chunks. Retain only its possible prefix.
      const end = Math.max(start, input.length - separator.length + 1);
      append(input.subarray(start, end));
      pending = Buffer.from(input.subarray(end));
    },
    finish() {
      append(pending);
      finishPatch();
      return Buffer.concat(chunks);
    },
  };
}

async function executeGitCommandWithOutput<Result extends SpawnResult | BufferSpawnResult>(
  run: (argv: string[], options: CommandOptions) => Promise<Result>,
  replaceStdout: (result: Result, stdout: Buffer) => Result,
  cwd: string,
  args: string[],
  options: GitCommandOptions,
): Promise<Result & { timeoutMs: number }> {
  const env = gitReadOnlyEnvironment(args, options.env ?? {});
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const argv = gitExecutionArgv(cwd, args, options);
  const runAttempt = async (attemptOptions: CommandOptions) => {
    if (options.maxPatchBytes === undefined) {
      return await run(argv, attemptOptions);
    }
    const capture = createGitPatchCapture(options.maxPatchBytes);
    const result = await run(argv, {
      ...attemptOptions,
      outputCapture: "discard",
      tolerateOutputError: { stderr: true },
      onOutputChunk: (chunk, stream) => {
        if (stream === "stdout") {
          capture.append(chunk);
        }
      },
    });
    return replaceStdout({ ...result, stdoutTruncatedBytes: undefined }, capture.finish());
  };
  if (options.waitForExit === true) {
    const start = () => {
      options.beforeRun?.();
      return runAttempt({
        ...options,
        env,
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
      runAttempt({
        ...options,
        env,
        timeoutMs: attemptTimeoutMs,
      }),
  );
  return { ...result, timeoutMs };
}

export type GitBufferedCommandOptions = BufferedCommandOptions & {
  refMutationDirectory?: string;
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
  const { runCommandBuffered } = await import("../process/exec.js");
  const env = gitReadOnlyEnvironment(args, options.env ?? {});
  const argv = gitExecutionArgv(cwd, args, {
    ...options,
    killProcessTree: options.killProcessTree !== false,
  });
  return await withGitProcessOperation(options.operation, () =>
    withGitNetworkRetry(
      retryableGitNetworkOperation(args),
      { ...options, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS },
      (timeoutMs) => runCommandBuffered(argv, { ...options, env, timeoutMs }),
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
  let failed: GitCommandResult | undefined;
  if (result.termination !== "exit" || result.code !== 0) {
    failed = result;
  } else if (result.stdoutTruncatedBytes) {
    // Required stdout is data; a clean exit cannot make truncated output complete.
    failed = { ...result, code: null, outputLimitExceeded: true };
  }
  if (failed) {
    // Required-output translation must preserve native settlement and cancellation,
    // without retaining command output in the private lifecycle facts.
    throw recordCommandProcessFailure(createError(command, failed), {
      pid: result.pid,
      code: result.code,
      cleanup: result.cleanup,
      termination: result.termination,
      killIssuedByAbort: result.killIssuedByAbort,
      outputLimitExceeded: result.outputLimitExceeded,
    });
  }
  return result.stdout;
}

// Git config filenames need "NUL" on Windows; os.devNull's device path is invalid.
// Config values such as core.hooksPath still accept os.devNull.
export function gitNullConfigPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/** Quote a Git config value without treating its contents as config syntax. */
export function quoteGitConfig(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n").replace(/\t/gu, "\\t").replaceAll("\b", "\\b")}"`;
}
