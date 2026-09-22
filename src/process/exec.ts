import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { decodeWindowsOutputBuffer } from "../infra/windows-encoding.js";
import { createDeferredCore } from "../shared/deferred.js";
import { releaseChildProcessOutputAfterExit } from "./child-process.js";
import { resolveMaxOutputBytes, type CommandOutputStream } from "./exec-output.js";
import { createSanitizedCommandError } from "./exec-result.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import {
  COMMAND_PROCESS_TREE_KILL_GRACE_MS,
  resolveCommandProcessSignal,
  spawnCommand,
  waitForCommandSpawn,
} from "./exec-spawn.js";
import { BrokerChild } from "./spawn-broker/child.js";
export { runCommandWithTimeout, runUtf8CommandWithTimeout } from "./exec-runner.js";
export type { CommandOptions } from "./exec-runner.js";
export { isPlainCommandExitFailure, resolveProcessExitCode } from "./exec-result.js";
export type { SpawnResult } from "./exec-result.js";
export { resolveCommandEnv, shouldSpawnWithShell, spawnCommand } from "./exec-spawn.js";

const DEFAULT_EXEC_MAX_BUFFER_BYTES = 1024 * 1024;

export type RunExecOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
  logOutput?: boolean;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  stdinFileDescriptor?: number;
  signal?: AbortSignal;
  /** Observe received bytes without changing buffering, completion or cancellation. */
  onOutputChunk?: (chunk: Buffer, stream: CommandOutputStream) => void;
};

function decodeExecOutput(buffer: Uint8Array): string {
  return decodeWindowsOutputBuffer({
    buffer: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  });
}

export async function runExec(
  command: string,
  args: string[],
  opts: number | RunExecOptions = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const timeout =
    typeof opts === "number"
      ? resolveTimerTimeoutMs(opts, 1)
      : typeof opts.timeoutMs === "number"
        ? resolveTimerTimeoutMs(opts.timeoutMs, 1)
        : undefined;
  const maxBuffer =
    typeof opts === "number"
      ? DEFAULT_EXEC_MAX_BUFFER_BYTES
      : (opts.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER_BYTES);
  const resolvedOptions = typeof opts === "number" ? undefined : opts;
  if (resolvedOptions?.input !== undefined && resolvedOptions.stdinFileDescriptor !== undefined) {
    throw new Error("runExec accepts either input or stdinFileDescriptor, not both");
  }
  let acceptingOutput = true;
  let awaitingStartup = true;
  let deadlineExpired = false;
  let releaseCancellation = () => {};
  try {
    const subprocess = spawnCommand([command, ...args], {
      baseEnv: resolvedOptions?.baseEnv,
      cancelSignal: resolvedOptions?.signal,
      cwd: resolvedOptions?.cwd,
      encoding: "buffer",
      env: resolvedOptions?.env,
      forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
      ...(resolvedOptions?.input !== undefined ? { input: resolvedOptions.input } : {}),
      maxBuffer,
      reject: true,
      ...(resolvedOptions?.stdinFileDescriptor === undefined
        ? { stdin: resolvedOptions?.input === undefined ? "ignore" : undefined }
        : {
            // Execa forwards arbitrary numeric stdin descriptors to Node, but its type narrows them to fd 0.
            stdin: resolvedOptions.stdinFileDescriptor as 0,
          }),
      stripFinalNewline: false,
      timeout,
    });
    const startupCanceled =
      subprocess.nodeChildProcess instanceof BrokerChild && subprocess.pid === undefined
        ? createDeferredCore<never>()
        : undefined;
    if (startupCanceled) {
      const signal = resolveCommandProcessSignal(resolvedOptions?.signal);
      let cancellationOpen = true;
      let deadline: NodeJS.Timeout | undefined;
      const stopCommand = (reason: "timeout" | "signal") => {
        if (!cancellationOpen) {
          return;
        }
        releaseCancellation();
        // Caller abort is already bridged; the host deadline needs its own stop request.
        if (reason === "timeout") {
          deadlineExpired = true;
          subprocess.kill();
        }
        // After admission, await execa's output and cleanup before reporting the timeout.
        if (!awaitingStartup) {
          return;
        }
        acceptingOutput = false;
        const flags = {
          failed: true,
          timedOut: reason === "timeout",
          isCanceled: reason === "signal",
          isMaxBuffer: false,
          isTerminated: false,
        };
        const error = createSanitizedCommandError(flags);
        startupCanceled.reject(
          Object.assign(error, flags, {
            shortMessage: error.message,
            stdout: "",
            stderr: "",
            cleanup: "uncertain",
          }),
        );
      };
      const onAbort = () => stopCommand("signal");
      releaseCancellation = () => {
        cancellationOpen = false;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeout !== undefined) {
        deadline = setTimeout(() => stopCommand("timeout"), timeout);
      }
      if (signal?.aborted) {
        onAbort();
      }
    }
    // Keep draining and settling a late process after a local startup failure returns.
    const completion = (async () => {
      if (subprocess.pid === undefined) {
        await waitForCommandSpawn(subprocess);
      }
      awaitingStartup = false;
      const releaseOutput = releaseChildProcessOutputAfterExit(subprocess.nodeChildProcess);
      let observer = acceptingOutput ? resolvedOptions?.onOutputChunk : undefined;
      const observe = (chunk: Buffer, stream: CommandOutputStream) => {
        try {
          observer?.(chunk, stream);
        } catch {
          // Diagnostic observers cannot replace the command's outcome.
          observer = undefined;
        }
      };
      const onStdout = (chunk: Buffer) => observe(chunk, "stdout");
      const onStderr = (chunk: Buffer) => observe(chunk, "stderr");
      if (observer) {
        subprocess.nodeChildProcess.stdout?.on("data", onStdout);
        subprocess.nodeChildProcess.stderr?.on("data", onStderr);
      }
      const result = await subprocess.finally(() => {
        releaseCancellation();
        releaseOutput();
        subprocess.nodeChildProcess.stdout?.off("data", onStdout);
        subprocess.nodeChildProcess.stderr?.off("data", onStderr);
      });
      if (deadlineExpired) {
        const error = createSanitizedCommandError({ timedOut: true });
        throw Object.assign(error, result, {
          failed: true,
          timedOut: true,
          shortMessage: error.message,
        });
      }
      const { stdout, stderr } = result;
      const decodedStdout = decodeExecOutput(stdout);
      const decodedStderr = decodeExecOutput(stderr);
      if (acceptingOutput && resolvedOptions?.logOutput !== false) {
        const [{ shouldLogVerbose }, { logDebug, logError }] = await Promise.all([
          import("../globals.js"),
          import("../logger.js"),
        ]);
        if (shouldLogVerbose()) {
          if (decodedStdout.trim()) {
            logDebug(decodedStdout.trim());
          }
          if (decodedStderr.trim()) {
            logError(decodedStderr.trim());
          }
        }
      }
      return { stdout: decodedStdout, stderr: decodedStderr };
    })();
    return await (startupCanceled
      ? Promise.race([completion, startupCanceled.promise])
      : completion);
  } catch (err) {
    releaseCancellation();
    if (err && typeof err === "object") {
      const errorWithOutput = err as {
        code?: string | number;
        exitCode?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        timedOut?: boolean;
      };
      if (deadlineExpired && !errorWithOutput.timedOut) {
        const message = createSanitizedCommandError({ timedOut: true }).message;
        if (err instanceof Error) {
          err.stack = err.stack?.replace(err.message, message);
        }
        Object.assign(err, { failed: true, timedOut: true, message, shortMessage: message });
      }
      if (errorWithOutput.code === undefined && typeof errorWithOutput.exitCode === "number") {
        errorWithOutput.code = errorWithOutput.exitCode;
      }
      if (errorWithOutput.stdout instanceof Uint8Array) {
        errorWithOutput.stdout = decodeExecOutput(errorWithOutput.stdout);
      }
      if (errorWithOutput.stderr instanceof Uint8Array) {
        errorWithOutput.stderr = decodeExecOutput(errorWithOutput.stderr);
      }
    }
    if (resolvedOptions?.logOutput !== false) {
      // Logging imports must not replace the original command failure.
      const logging = await Promise.all([import("../globals.js"), import("../logger.js")]).catch(
        () => undefined,
      );
      if (logging) {
        const [{ danger, shouldLogVerbose }, { logError }] = logging;
        if (shouldLogVerbose()) {
          logError(danger(`Command failed: ${command}`));
        }
      }
    }
    throw err;
  } finally {
    acceptingOutput = false;
    releaseCancellation();
  }
}

export type BufferedCommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  input?: string | Uint8Array;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number | { stdout?: number; stderr?: number };
  maxCombinedOutputBytes?: number;
  discardOutput?: { stdout?: boolean; stderr?: boolean };
  tolerateOutputError?: { stdout?: boolean; stderr?: boolean };
  terminateOnOutputError?: boolean | { stdout?: boolean; stderr?: boolean };
  killProcessTree?: boolean;
  killGraceMs?: number;
};

export type BufferedCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "signal" | "output-limit" | "error";
  outputLimitStream?: CommandOutputStream;
  errorStream?: CommandOutputStream;
  error?: Error;
};

/** Run a one-shot command with raw, independently capped stdout and stderr buffers. */
export async function runCommandBuffered(
  argv: string[],
  options: BufferedCommandOptions = {},
): Promise<BufferedCommandResult> {
  if (options.signal?.aborted) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: null,
      signal: null,
      killed: false,
      termination: "signal",
      ...(options.signal.reason instanceof Error ? { error: options.signal.reason } : {}),
    };
  }

  const chunks: Record<CommandOutputStream, Buffer[]> = { stdout: [], stderr: [] };
  const capturedBytes: Record<CommandOutputStream, number> = { stdout: 0, stderr: 0 };
  const maxCombinedOutputBytes =
    typeof options.maxCombinedOutputBytes === "number" &&
    Number.isFinite(options.maxCombinedOutputBytes) &&
    options.maxCombinedOutputBytes > 0
      ? Math.max(1, Math.floor(options.maxCombinedOutputBytes))
      : undefined;
  let outputLimitStream: CommandOutputStream | undefined;
  const appendChunk = (chunk: Buffer, stream: CommandOutputStream): boolean => {
    if (options.discardOutput?.[stream]) {
      return true;
    }
    const maxBytes = resolveMaxOutputBytes(options.maxOutputBytes, stream);
    const combinedBytes = capturedBytes.stdout + capturedBytes.stderr;
    const combinedRemaining =
      maxCombinedOutputBytes === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, maxCombinedOutputBytes - combinedBytes);
    const remaining = Math.max(0, Math.min(maxBytes - capturedBytes[stream], combinedRemaining));
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, remaining));
      chunks[stream].push(captured);
      capturedBytes[stream] += captured.byteLength;
    }
    if (chunk.byteLength > remaining) {
      outputLimitStream ??= stream;
      return false;
    }
    return true;
  };
  const capturedOutput = (stream: CommandOutputStream) =>
    Buffer.concat(chunks[stream], capturedBytes[stream]);

  try {
    const result = await runCommandWithTimeout(argv, {
      baseEnv: options.baseEnv,
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      killProcessTree: options.killProcessTree ?? true,
      killGraceMs: options.killGraceMs,
      onOutputChunk: appendChunk,
      outputCapture: "discard",
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      tolerateOutputError: {
        stdout: options.discardOutput?.stdout || options.tolerateOutputError?.stdout,
        stderr: options.discardOutput?.stderr || options.tolerateOutputError?.stderr,
      },
      terminateOnOutputError: options.terminateOnOutputError,
    });
    const termination: BufferedCommandResult["termination"] = result.outputLimitExceeded
      ? "output-limit"
      : result.termination === "no-output-timeout"
        ? "timeout"
        : result.termination;
    return {
      stdout: capturedOutput("stdout"),
      stderr: capturedOutput("stderr"),
      code: termination === "exit" ? result.code : null,
      signal: result.signal,
      killed: result.killed,
      termination,
      ...(outputLimitStream ? { outputLimitStream } : {}),
      ...(result.outputErrorStream ? { errorStream: result.outputErrorStream } : {}),
    };
  } catch (error) {
    const commandError = error instanceof Error ? error : new Error("Command execution failed");
    const metadata = commandError as Error & {
      exitCode?: unknown;
      outputErrorStream?: unknown;
    };
    const errorStream =
      metadata.outputErrorStream === "stdout" || metadata.outputErrorStream === "stderr"
        ? metadata.outputErrorStream
        : undefined;
    return {
      stdout: capturedOutput("stdout"),
      stderr: capturedOutput("stderr"),
      code: typeof metadata.exitCode === "number" ? metadata.exitCode : null,
      signal: null,
      killed: false,
      termination: "error",
      ...(errorStream ? { errorStream } : {}),
      error: commandError,
    };
  }
}
