import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createCommandError } from "../process/command-error.js";
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandBuffersWithTimeout, type BufferSpawnResult } from "../process/exec-runner.js";
import {
  runCommandWithTimeout,
  type BufferedCommandResult,
  type CommandOptions,
} from "../process/exec.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { areDiagnosticsEnabledForProcess } from "./diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { createFixedWindowBudget } from "./fixed-window-rate-limit.js";

export const GIT_TIMEOUT_MS = 120_000;
// Keep live writers ordered across runtime chunks and shutdown. Settled tails
// remove themselves; resetting this queue would release already-owned cleanup.
const gitRefMutations = resolveGlobalSingleton(
  Symbol.for("openclaw.gitRefMutations"),
  () => new KeyedAsyncQueue(),
);
const refMutationLog = createSubsystemLogger("git/ref-mutation");

function startRefMutationTiming() {
  try {
    if (!areDiagnosticsEnabledForProcess() || !refMutationLog.isEnabled("info")) {
      return undefined;
    }
    const startedAt = performance.now();
    const trace = getActiveDiagnosticTraceContext();
    let enqueuedAt: number | undefined;
    let enteredAt: number | undefined;
    return {
      enqueue() {
        enqueuedAt = performance.now();
      },
      enter() {
        enteredAt = performance.now();
      },
      finish(outcome: "returned" | "threw") {
        try {
          const endedAt = performance.now();
          const durationMs = endedAt - startedAt;
          if (
            durationMs < 1_000 ||
            !areDiagnosticsEnabledForProcess() ||
            !refMutationLog.isEnabled("info")
          ) {
            return;
          }
          const state = resolveGlobalSingleton(
            Symbol.for("openclaw.gitRefMutationDiagnostics"),
            () => ({
              budget: createFixedWindowBudget({
                maxRequests: 60,
                windowMs: 60_000,
                now: () => performance.now(),
              }),
              omitted: 0,
            }),
          );
          if (!state.budget.consume().allowed) {
            state.omitted = Math.min(Number.MAX_SAFE_INTEGER, state.omitted + 1);
            return;
          }
          runWithDiagnosticTraceContext(trace, () =>
            refMutationLog.info("slow Git ref mutation", {
              pid: process.pid,
              threadId,
              isMainThread,
              durationMs: Math.round(durationMs),
              resolveMs: Math.round((enqueuedAt ?? endedAt) - startedAt),
              ...(enqueuedAt !== undefined && enteredAt !== undefined
                ? {
                    queueWaitMs: Math.round(enteredAt - enqueuedAt),
                    queuedOperationMs: Math.round(endedAt - enteredAt),
                  }
                : {}),
              callbackEntered: enteredAt !== undefined,
              outcome,
              omittedObservations: state.omitted,
            }),
          );
          state.omitted = 0;
        } catch {
          // Diagnostics must preserve the queued operation's result or original error.
        }
      },
    };
  } catch {
    return undefined;
  }
}

export async function enqueueGitRefMutation<T>(
  cwd: string,
  commonDirectory: string,
  run: () => Promise<T>,
): Promise<T> {
  const timing = startRefMutationTiming();
  let outcome: "returned" | "threw" = "threw";
  try {
    const commonPath = normalizeGitPathForFilesystem(commonDirectory);
    const commonDir = await fs.realpath(path.resolve(cwd, commonPath));
    const key = process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
    // Even deleting a loose ref locks shared packed-refs. Queue every ref owner
    // across linked worktrees; external contention retains its native error.
    timing?.enqueue();
    const result = await gitRefMutations.enqueue(
      key,
      timing
        ? () => {
            timing.enter();
            return run();
          }
        : run,
    );
    outcome = "returned";
    return result;
  } finally {
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

export function withForegroundGitMaintenance(argv: string[]): string[] {
  // Maintenance and legacy auto-GC must stay in their cancellable process tree.
  return argv[0] === "git"
    ? ["git", "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false", ...argv.slice(1)]
    : argv;
}

export type GitCommandOptions = Pick<
  CommandOptions,
  | "baseEnv"
  | "env"
  | "input"
  | "timeoutMs"
  | "signal"
  | "killProcessTree"
  | "maxOutputBytes"
  | "terminateOnOutputLimit"
>;
export type GitCommandBytesResult = BufferSpawnResult & { timeoutMs: number };

export async function executeGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const argv = ["git", "-C", cwd, ...args];
  const result = await runCommandWithTimeout(
    options.killProcessTree ? withForegroundGitMaintenance(argv) : argv,
    { ...options, timeoutMs },
  );
  return { ...result, timeoutMs };
}

/** The same command/timeout contract, with output bytes owned by a worker consumer. */
export async function executeGitCommandBytes(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandBytesResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const argv = ["git", "-C", cwd, ...args];
  const result = await runCommandBuffersWithTimeout(
    options.killProcessTree ? withForegroundGitMaintenance(argv) : argv,
    { ...options, timeoutMs },
  );
  return { ...result, timeoutMs };
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
    error.message += `\nGit did not finish within its ${timeoutMs / 1000}s budget; check remote reachability, repository locks, and clone shape (partial clones fetch missing objects lazily).`;
  }
  return error;
}

export async function requireGitCommand(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array; timeoutMs?: number } = {},
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

/**
 * Null device path that Git for Windows can open as a config file.
 *
 * `os.devNull` returns `\.\nul` on Windows, which Git rejects with
 * "unable to access '\.\nul': Invalid argument" (exit 128) when passed via
 * `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` — it must open and parse those
 * files. "NUL" is the path Git for Windows understands. Config *values* such
 * as `core.hooksPath` accept the device path and need no change.
 */
export function gitNullConfigPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}
