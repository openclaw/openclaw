// Exec helpers run subprocesses with normalized output, timeout, and abort handling.
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { expectDefined } from "@openclaw/normalization-core";
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import { danger, shouldLogVerbose } from "../globals.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { logDebug, logError } from "../logger.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import { releaseChildProcessOutputAfterExit } from "./child-process.js";
import { killProcessTree as terminateProcessTree } from "./kill-tree.js";
import { resolveCommandStdio } from "./spawn-utils.js";
import { resolveSafeChildProcessInvocation } from "./windows-command.js";

function assignChildEnvValue(params: {
  env: NodeJS.ProcessEnv;
  key: string;
  platform: NodeJS.Platform;
  value: string | undefined;
}): void {
  if (params.value === undefined) {
    return;
  }
  if (params.platform === "win32") {
    const normalizedKey = params.key.toLowerCase();
    for (const existingKey of Object.keys(params.env)) {
      if (existingKey.toLowerCase() === normalizedKey && existingKey !== params.key) {
        delete params.env[existingKey];
      }
    }
  }
  params.env[params.key] = params.value;
}

function mergeChildEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(params.baseEnv)) {
    assignChildEnvValue({ env: resolvedEnv, key, platform: params.platform, value });
  }
  for (const [key, value] of Object.entries(params.env ?? {})) {
    assignChildEnvValue({ env: resolvedEnv, key, platform: params.platform, value });
  }
  return resolvedEnv;
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

export type SpawnCommandOptions = Omit<
  ExecaOptions,
  "env" | "extendEnv" | "shell" | "windowsHide" | "windowsVerbatimArguments"
> & {
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
};

function spawnCommandWithInvocation<OptionsType extends SpawnCommandOptions = SpawnCommandOptions>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): {
  child: ResultPromise<OptionsType>;
  invocation: ReturnType<typeof resolveSafeChildProcessInvocation>;
} {
  const { baseEnv, env, windowsVerbatimArguments, ...execaOptions } = options;
  const commandEnv = resolveCommandEnv({ argv, baseEnv, env });
  const invocation = resolveSafeChildProcessInvocation({
    argv,
    cwd: execaOptions.cwd,
    env: commandEnv,
    windowsVerbatimArguments,
  });
  const child = execa(invocation.command, invocation.args, {
    ...execaOptions,
    env: commandEnv,
    extendEnv: false,
    shell: false,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }) as unknown as ResultPromise<OptionsType>;
  return { child, invocation };
}

/** Spawn through the canonical argv, environment, and Windows safety boundary. */
export function spawnCommand<OptionsType extends SpawnCommandOptions = SpawnCommandOptions>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): ResultPromise<OptionsType> {
  return spawnCommandWithInvocation(argv, options).child;
}

export type RunExecOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
  logOutput?: boolean;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  signal?: AbortSignal;
};

// Simple promise-wrapped execFile with optional verbosity logging.
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
      stdin: resolvedOptions?.input === undefined ? "ignore" : undefined,
      stripFinalNewline: false,
      timeout,
    });
    const releaseOutput = releaseChildProcessOutputAfterExit(subprocess);
    const { stdout, stderr } = await subprocess.finally(releaseOutput);
    const windowsEncoding = resolveWindowsConsoleEncoding();
    const decodedStdout = decodeWindowsOutputBuffer({
      buffer: Buffer.from(stdout),
      windowsEncoding,
    });
    const decodedStderr = decodeWindowsOutputBuffer({
      buffer: Buffer.from(stderr),
      windowsEncoding,
    });
    if (resolvedOptions?.logOutput !== false && shouldLogVerbose()) {
      if (decodedStdout.trim()) {
        logDebug(decodedStdout.trim());
      }
      if (decodedStderr.trim()) {
        logError(decodedStderr.trim());
      }
    }
    return { stdout: decodedStdout, stderr: decodedStderr };
  } catch (err) {
    const windowsEncoding = resolveWindowsConsoleEncoding();
    if (err && typeof err === "object") {
      const errorWithOutput = err as {
        code?: string | number;
        exitCode?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      if (errorWithOutput.code === undefined && typeof errorWithOutput.exitCode === "number") {
        errorWithOutput.code = errorWithOutput.exitCode;
      }
      if (errorWithOutput.stdout instanceof Uint8Array) {
        errorWithOutput.stdout = decodeWindowsOutputBuffer({
          buffer: Buffer.from(errorWithOutput.stdout),
          windowsEncoding,
        });
      }
      if (errorWithOutput.stderr instanceof Uint8Array) {
        errorWithOutput.stderr = decodeWindowsOutputBuffer({
          buffer: Buffer.from(errorWithOutput.stderr),
          windowsEncoding,
        });
      }
    }
    if (resolvedOptions?.logOutput !== false && shouldLogVerbose()) {
      logError(danger(`Command failed: ${command}`));
    }
    throw err;
  }
}

export type SpawnResult = {
  pid?: number;
  stdout: string;
  stderr: string;
  stdoutTruncatedBytes?: number;
  stderrTruncatedBytes?: number;
  preservedStdoutLines?: string[];
  preservedStderrLines?: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  noOutputTimedOut?: boolean;
  outputLimitExceeded?: boolean;
  outputErrorStream?: "stdout" | "stderr";
};

type CommandTerminationReason = SpawnResult["termination"] | "output-limit";
type CommandOutputCaptureMode = "head" | "tail" | "discard";
type CommandOutputStream = "stdout" | "stderr";

type BufferedCommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  input?: string | Uint8Array;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number | { stdout?: number; stderr?: number };
  discardOutput?: { stdout?: boolean; stderr?: boolean };
  tolerateOutputError?: { stdout?: boolean; stderr?: boolean };
};

type BufferedCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "signal" | "output-limit" | "error";
  outputLimitStream?: "stdout" | "stderr";
  errorStream?: CommandOutputStream;
  error?: Error;
};

export type CommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  input?: string | Uint8Array;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number | { stdout?: number; stderr?: number };
  maxCombinedOutputBytes?: number;
  outputCapture?:
    | CommandOutputCaptureMode
    | { stdout?: CommandOutputCaptureMode; stderr?: CommandOutputCaptureMode };
  /** Observe raw output without owning child lifecycle. Return false to stop the command. */
  onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => boolean | void;
  /** Accept a successful exit when only the selected diagnostic output stream failed. */
  tolerateOutputError?: { stdout?: boolean; stderr?: boolean };
  terminateOnOutputLimit?: boolean | { stdout?: boolean; stderr?: boolean; combined?: boolean };
  maxPreservedOutputLines?: number;
  preserveOutputLine?: (line: string, stream: "stdout" | "stderr") => boolean;
  killProcessTree?: boolean;
};

const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;
const WINDOWS_CLOSE_STATE_POLL_MS = 10;
const DEFAULT_EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const TIMEOUT_EXIT_CODE = 124;
const DEFAULT_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PRESERVED_PENDING_LINE_BYTES = 8 * 1024;

type CapturedOutputBuffers = {
  chunks: Buffer[];
  bytes: number;
  truncatedBytes: number;
  preservedLines: string[];
  decoder: StringDecoder;
  pendingLine: string;
};

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMAND_OUTPUT_MAX_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

function resolveMaxOutputBytes(
  value: CommandOptions["maxOutputBytes"],
  stream: "stdout" | "stderr",
): number {
  return normalizeMaxOutputBytes(typeof value === "number" ? value : value?.[stream]);
}

function createSanitizedCommandError(result: {
  code?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
}): Error {
  const code = typeof result.code === "string" ? result.code : undefined;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const signal = typeof result.signal === "string" ? result.signal : undefined;
  const message = result.timedOut
    ? "Command timed out"
    : result.isMaxBuffer
      ? "Command output exceeded its capture limit"
      : result.isCanceled
        ? "Command was canceled"
        : result.isTerminated
          ? `Command was terminated${signal ? ` by ${signal}` : ""}`
          : exitCode !== undefined && exitCode !== 0
            ? `Command exited with code ${exitCode}`
            : `Command failed during launch or output capture${code ? ` (${code})` : ""}`;
  return Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function isPlainCommandExitFailure(result: {
  failed: boolean;
  exitCode?: unknown;
  signal?: unknown;
  cause?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
}): boolean {
  return (
    result.failed &&
    typeof result.exitCode === "number" &&
    result.exitCode !== 0 &&
    result.signal === undefined &&
    result.cause === undefined &&
    !result.timedOut &&
    !result.isCanceled &&
    !result.isMaxBuffer &&
    !result.isTerminated
  );
}

function isPlainCommandSignalFailure(result: {
  failed: boolean;
  exitCode?: unknown;
  signal?: unknown;
  cause?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
}): boolean {
  return (
    result.failed &&
    result.exitCode === undefined &&
    typeof result.signal === "string" &&
    result.cause === undefined &&
    !result.timedOut &&
    !result.isCanceled &&
    !result.isMaxBuffer &&
    result.isTerminated === true
  );
}

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
  let outputLimitStream: CommandOutputStream | undefined;
  const appendChunk = (chunk: Buffer, stream: CommandOutputStream): boolean => {
    if (options.discardOutput?.[stream]) {
      return true;
    }
    const maxBytes = resolveMaxOutputBytes(options.maxOutputBytes, stream);
    const remaining = Math.max(0, maxBytes - capturedBytes[stream]);
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
      killProcessTree: true,
      onOutputChunk: appendChunk,
      outputCapture: "discard",
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      tolerateOutputError: {
        stdout: options.discardOutput?.stdout || options.tolerateOutputError?.stdout,
        stderr: options.discardOutput?.stderr || options.tolerateOutputError?.stderr,
      },
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

function resolveOutputCapture(
  value: CommandOptions["outputCapture"],
  stream: "stdout" | "stderr",
): CommandOutputCaptureMode {
  return (typeof value === "string" ? value : value?.[stream]) ?? "tail";
}

function shouldTerminateOnOutputLimit(
  value: CommandOptions["terminateOnOutputLimit"],
  limit: "stdout" | "stderr" | "combined",
): boolean {
  return typeof value === "boolean" ? value : value?.[limit] === true;
}

function appendCapturedOutput(
  capture: CapturedOutputBuffers,
  chunk: Buffer | string,
  maxBytes: number,
  mode: CommandOutputCaptureMode,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (mode === "discard") {
    capture.truncatedBytes += buffer.byteLength;
    return;
  }
  if (mode === "head") {
    const remaining = Math.max(0, maxBytes - capture.bytes);
    if (remaining > 0) {
      const kept = buffer.subarray(0, remaining);
      capture.chunks.push(kept);
      capture.bytes += kept.byteLength;
    }
    capture.truncatedBytes += Math.max(0, buffer.byteLength - remaining);
    return;
  }
  if (buffer.byteLength >= maxBytes) {
    capture.chunks = [Buffer.from(buffer.subarray(buffer.byteLength - maxBytes))];
    capture.truncatedBytes += capture.bytes + buffer.byteLength - maxBytes;
    capture.bytes = maxBytes;
    return;
  }

  capture.chunks.push(buffer);
  capture.bytes += buffer.byteLength;
  while (capture.bytes > maxBytes && capture.chunks.length > 0) {
    const first = expectDefined(capture.chunks[0], "chunks entry at 0");
    const overflow = capture.bytes - maxBytes;
    if (first.byteLength <= overflow) {
      capture.chunks.shift();
      capture.bytes -= first.byteLength;
      capture.truncatedBytes += first.byteLength;
    } else {
      capture.chunks[0] = Buffer.from(first.subarray(overflow));
      capture.bytes -= overflow;
      capture.truncatedBytes += overflow;
    }
  }
}

function trimTruncatedUtf8Boundary(
  buffer: Buffer,
  mode: CommandOutputCaptureMode,
  truncatedBytes: number,
): Buffer {
  if (truncatedBytes === 0 || buffer.length === 0 || process.platform === "win32") {
    return buffer;
  }
  if (mode === "tail") {
    let start = 0;
    while (start < buffer.length && (expectDefined(buffer[start], "buffer byte") & 0xc0) === 0x80) {
      start += 1;
    }
    return buffer.subarray(start);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let removed = 0; removed <= 3 && removed <= buffer.length; removed += 1) {
    const end = buffer.length - removed;
    try {
      decoder.decode(buffer.subarray(0, end));
      return buffer.subarray(0, end);
    } catch {
      // A UTF-8 code point is at most four bytes; try the preceding boundary.
    }
  }
  return buffer;
}

function finalizeCapturedOutput(
  capture: CapturedOutputBuffers,
  mode: CommandOutputCaptureMode,
): Buffer {
  const buffered = Buffer.concat(capture.chunks, capture.bytes);
  const trimmed = trimTruncatedUtf8Boundary(buffered, mode, capture.truncatedBytes);
  capture.truncatedBytes += buffered.byteLength - trimmed.byteLength;
  return trimmed;
}

function trimPreservedPendingLine(value: string, maxBytes: number): string {
  return truncateUtf8Suffix(value, maxBytes);
}

function appendPreservedOutputLines(params: {
  capture: CapturedOutputBuffers;
  chunk: Buffer | string;
  stream: "stdout" | "stderr";
  preserveOutputLine?: CommandOptions["preserveOutputLine"];
  maxPreservedOutputLines: number;
  maxPendingLineBytes: number;
}): void {
  if (!params.preserveOutputLine || params.maxPreservedOutputLines <= 0) {
    return;
  }
  const text = Buffer.isBuffer(params.chunk)
    ? params.capture.decoder.write(params.chunk)
    : params.chunk;
  if (!text) {
    return;
  }
  const lines = (params.capture.pendingLine + text).split(/\r?\n/);
  params.capture.pendingLine = trimPreservedPendingLine(
    lines.pop() ?? "",
    params.maxPendingLineBytes,
  );
  for (const line of lines) {
    if (
      params.capture.preservedLines.length < params.maxPreservedOutputLines &&
      params.preserveOutputLine(line, params.stream)
    ) {
      params.capture.preservedLines.push(line);
    }
  }
}

function flushPreservedOutputLine(params: {
  capture: CapturedOutputBuffers;
  stream: "stdout" | "stderr";
  preserveOutputLine?: CommandOptions["preserveOutputLine"];
  maxPreservedOutputLines: number;
  maxPendingLineBytes: number;
}): void {
  if (!params.preserveOutputLine || params.maxPreservedOutputLines <= 0) {
    return;
  }
  const trailing = trimPreservedPendingLine(
    params.capture.pendingLine + params.capture.decoder.end(),
    params.maxPendingLineBytes,
  );
  params.capture.pendingLine = "";
  if (
    trailing &&
    params.capture.preservedLines.length < params.maxPreservedOutputLines &&
    params.preserveOutputLine(trailing, params.stream)
  ) {
    params.capture.preservedLines.push(trailing);
  }
}
export function resolveProcessExitCode(params: {
  explicitCode: number | null | undefined;
  childExitCode: number | null | undefined;
  resolvedSignal: NodeJS.Signals | null;
  usesWindowsExitCodeShim: boolean;
  timedOut: boolean;
  noOutputTimedOut: boolean;
  killIssuedByTimeout: boolean;
  killIssuedByAbort?: boolean;
}): number | null {
  return (
    params.explicitCode ??
    params.childExitCode ??
    (params.usesWindowsExitCodeShim &&
    params.resolvedSignal == null &&
    !params.timedOut &&
    !params.noOutputTimedOut &&
    !params.killIssuedByTimeout &&
    !params.killIssuedByAbort
      ? 0
      : null)
  );
}

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
  const platform = params.platform ?? process.platform;
  const argv = params.argv;
  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const resolvedEnv = mergeChildEnv({ baseEnv, env: params.env, platform });
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }
  return markOpenClawExecEnv(resolvedEnv);
}

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const { timeoutMs, cwd, input, baseEnv, env, noOutputTimeoutMs, signal, killProcessTree } =
    options;
  const resolvedTimeoutMs =
    typeof timeoutMs === "number" ? resolveTimerTimeoutMs(timeoutMs, 1) : undefined;
  const hasInput = input !== undefined;
  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });

  if (signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      killed: false,
      termination: "signal",
      noOutputTimedOut: false,
    };
  }

  const stdoutCapture: CapturedOutputBuffers = {
    chunks: [],
    bytes: 0,
    truncatedBytes: 0,
    preservedLines: [],
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
  };
  const stderrCapture: CapturedOutputBuffers = {
    chunks: [],
    bytes: 0,
    truncatedBytes: 0,
    preservedLines: [],
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
  };
  const maxStdoutBytes = resolveMaxOutputBytes(options.maxOutputBytes, "stdout");
  const maxStderrBytes = resolveMaxOutputBytes(options.maxOutputBytes, "stderr");
  const maxCombinedOutputBytes =
    typeof options.maxCombinedOutputBytes === "number" &&
    Number.isFinite(options.maxCombinedOutputBytes) &&
    options.maxCombinedOutputBytes > 0
      ? Math.max(1, Math.floor(options.maxCombinedOutputBytes))
      : undefined;
  const stdoutCaptureMode = resolveOutputCapture(options.outputCapture, "stdout");
  const stderrCaptureMode = resolveOutputCapture(options.outputCapture, "stderr");
  if (maxCombinedOutputBytes !== undefined && stdoutCaptureMode !== stderrCaptureMode) {
    throw new Error("maxCombinedOutputBytes requires matching stdout and stderr capture modes");
  }
  const usesCombinedTailCapture =
    maxCombinedOutputBytes !== undefined &&
    stdoutCaptureMode === "tail" &&
    stderrCaptureMode === "tail";
  const maxPreservedPendingLineBytes = Math.min(
    Math.max(maxStdoutBytes, maxStderrBytes),
    MAX_PRESERVED_PENDING_LINE_BYTES,
  );
  const maxPreservedOutputLines = Math.max(0, Math.floor(options.maxPreservedOutputLines ?? 16));
  const windowsEncoding = resolveWindowsConsoleEncoding();
  const cancelController = new AbortController();
  let termination: CommandTerminationReason | undefined;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let childExited = false;
  let commandSettled = false;
  let combinedOutputBytes = 0;
  let combinedCapturedBytes = 0;
  const outputBytesByStream = { stdout: 0, stderr: 0 };
  const combinedCapturedBytesByStream = { stdout: 0, stderr: 0 };
  const combinedTailChunks: Array<{ stream: "stdout" | "stderr"; buffer: Buffer }> = [];
  let noOutputTimer: NodeJS.Timeout | undefined;
  let processTreeSettleAt: number | undefined;
  let windowsTerminationPromise: Promise<void> | undefined;
  let outputObserverError: unknown;
  let outputErrorStream: CommandOutputStream | undefined;

  const { child, invocation } = spawnCommandWithInvocation(argv, {
    buffer: false,
    cancelSignal: cancelController.signal,
    cwd,
    detached: Boolean(killProcessTree && process.platform !== "win32"),
    encoding: "buffer",
    baseEnv,
    env,
    forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
    ...(hasInput ? { input } : {}),
    reject: false,
    stdio,
    stripFinalNewline: false,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });
  const releaseOutput = releaseChildProcessOutputAfterExit(child);
  child.once("exit", (code, signalValue) => {
    childExited = true;
    childExitState = { code, signal: signalValue };
  });

  const clearNoOutputTimer = () => {
    if (noOutputTimer) {
      clearTimeout(noOutputTimer);
      noOutputTimer = undefined;
    }
  };
  const killDirectChild = () => {
    if (!childExited && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  };
  const spawnTaskkillOrFallback = (args: string[], onSpawnError: () => void) => {
    try {
      const taskkillChild = spawnCommand([getWindowsSystem32ExePath("taskkill.exe"), ...args], {
        baseEnv,
        env,
        forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
        reject: false,
        stdio: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      });
      return taskkillChild.then(
        (result) => {
          if (result.failed && result.exitCode === undefined) {
            onSpawnError();
          }
          return result;
        },
        () => {
          onSpawnError();
          return undefined;
        },
      );
    } catch {
      onSpawnError();
      return undefined;
    }
  };
  const startWindowsTermination = (childPid: number, graceful: boolean): Promise<void> => {
    const taskkills: Promise<unknown>[] = [];
    const startTaskkill = (args: string[]) => {
      const taskkill = spawnTaskkillOrFallback(args, killDirectChild);
      if (taskkill) {
        taskkills.push(taskkill);
      }
    };
    const terminationPromise = (async () => {
      if (graceful) {
        startTaskkill(["/PID", String(childPid), "/T"]);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, COMMAND_PROCESS_TREE_KILL_GRACE_MS);
          timer.unref();
        });
        if (!childExited && child.exitCode == null && child.signalCode == null) {
          startTaskkill(["/PID", String(childPid), "/T", "/F"]);
        }
      } else {
        startTaskkill(["/PID", String(childPid), "/T", "/F"]);
      }
      // taskkill owns the live PID while it enumerates descendants. Abort Execa
      // only after every started taskkill settles, avoiding a reused-PID race.
      await Promise.allSettled(taskkills);
      if (!commandSettled) {
        cancelController.abort();
      }
    })();
    windowsTerminationPromise = terminationPromise;
    return terminationPromise;
  };
  const terminateChild = (): Promise<void> | undefined => {
    const childPid = child.pid;
    const directChildAlive = !childExited && child.exitCode == null && child.signalCode == null;
    if (process.platform === "win32" && !directChildAlive) {
      // taskkill /T requires a live root PID. Retrying a dead, reusable PID can
      // target an unrelated tree; stronger ownership requires a spawn-time Job Object.
      return;
    }
    if (killProcessTree && typeof childPid === "number") {
      processTreeSettleAt ??= Date.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS;
      if (process.platform === "win32") {
        return startWindowsTermination(childPid, true);
      } else {
        terminateProcessTree(childPid, { graceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS });
      }
      return;
    }
    if (!directChildAlive) {
      return;
    }
    if (process.platform === "win32" && typeof childPid === "number") {
      return startWindowsTermination(childPid, false);
    }
    return undefined;
  };
  const settleTerminatedProcessTree = async () => {
    if (windowsTerminationPromise) {
      await windowsTerminationPromise;
    }
    if (!killProcessTree || processTreeSettleAt === undefined || typeof child.pid !== "number") {
      return;
    }
    // A direct child can exit before its descendants finish the graceful
    // signal. Keep the wrapper pending through that grace window, then ensure
    // the detached group cannot outlive the completed command result.
    const remainingMs = Math.max(0, processTreeSettleAt - Date.now());
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remainingMs);
      });
    }
    if (process.platform !== "win32") {
      terminateProcessTree(child.pid, { force: true });
    }
  };
  const cancel = (reason: Exclude<CommandTerminationReason, "exit">) => {
    if (termination || commandSettled) {
      return;
    }
    termination = reason;
    const terminationPromise = terminateChild();
    // A live Windows PID stays owned by taskkill until enumeration finishes.
    // Other platforms, and an already-dead Windows root, can abort immediately.
    if (!terminationPromise) {
      cancelController.abort();
    }
  };
  const shouldTrackOutputTimeout =
    typeof noOutputTimeoutMs === "number" &&
    Number.isFinite(noOutputTimeoutMs) &&
    noOutputTimeoutMs > 0;
  const resolvedNoOutputTimeoutMs = shouldTrackOutputTimeout
    ? resolveTimerTimeoutMs(noOutputTimeoutMs, 1)
    : undefined;
  const armNoOutputTimer = () => {
    if (resolvedNoOutputTimeoutMs === undefined || commandSettled || termination) {
      return;
    }
    clearNoOutputTimer();
    noOutputTimer = setTimeout(() => cancel("no-output-timeout"), resolvedNoOutputTimeoutMs);
  };

  const timeoutTimer =
    resolvedTimeoutMs === undefined
      ? undefined
      : setTimeout(() => cancel("timeout"), resolvedTimeoutMs);
  const onAbort = () => cancel("signal");
  signal?.addEventListener("abort", onAbort, { once: true });
  armNoOutputTimer();

  const captureOutput = (
    capture: CapturedOutputBuffers,
    chunk: Buffer | string,
    maxBytes: number,
    stream: "stdout" | "stderr",
    captureMode: CommandOutputCaptureMode,
  ) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytesByStream[stream] += buffer.byteLength;
    const streamLimitExceeded = outputBytesByStream[stream] > maxBytes;
    if (maxCombinedOutputBytes === undefined) {
      appendCapturedOutput(capture, buffer, maxBytes, captureMode);
      if (
        streamLimitExceeded &&
        shouldTerminateOnOutputLimit(options.terminateOnOutputLimit, stream)
      ) {
        cancel("output-limit");
      }
      return;
    }

    const combinedBytesBeforeChunk = combinedOutputBytes;
    combinedOutputBytes += buffer.byteLength;
    const combinedLimitExceeded = combinedOutputBytes > maxCombinedOutputBytes;
    if (usesCombinedTailCapture) {
      combinedTailChunks.push({ stream, buffer });
      combinedCapturedBytes += buffer.byteLength;
      combinedCapturedBytesByStream[stream] += buffer.byteLength;

      const removeCapturedBytes = (index: number, requestedBytes: number) => {
        const entry = expectDefined(combinedTailChunks[index], "combined tail chunk");
        const removedBytes = Math.min(requestedBytes, entry.buffer.byteLength);
        if (removedBytes === entry.buffer.byteLength) {
          combinedTailChunks.splice(index, 1);
        } else {
          entry.buffer = Buffer.from(entry.buffer.subarray(removedBytes));
        }
        combinedCapturedBytes -= removedBytes;
        combinedCapturedBytesByStream[entry.stream] -= removedBytes;
        (entry.stream === "stdout" ? stdoutCapture : stderrCapture).truncatedBytes += removedBytes;
      };

      while (combinedCapturedBytesByStream[stream] > maxBytes) {
        const index = combinedTailChunks.findIndex((entry) => entry.stream === stream);
        if (index < 0) {
          break;
        }
        removeCapturedBytes(index, combinedCapturedBytesByStream[stream] - maxBytes);
      }
      while (combinedCapturedBytes > maxCombinedOutputBytes) {
        removeCapturedBytes(0, combinedCapturedBytes - maxCombinedOutputBytes);
      }
    } else {
      const remaining = Math.max(0, maxCombinedOutputBytes - combinedBytesBeforeChunk);
      if (remaining > 0) {
        appendCapturedOutput(capture, buffer.subarray(0, remaining), maxBytes, captureMode);
      }
      capture.truncatedBytes += Math.max(0, buffer.byteLength - remaining);
    }
    if (
      (combinedLimitExceeded &&
        shouldTerminateOnOutputLimit(options.terminateOnOutputLimit, "combined")) ||
      (streamLimitExceeded && shouldTerminateOnOutputLimit(options.terminateOnOutputLimit, stream))
    ) {
      cancel("output-limit");
    }
  };

  const observeOutputChunk = (chunk: Buffer | string, stream: "stdout" | "stderr"): Buffer => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (termination || !options.onOutputChunk) {
      return buffer;
    }
    try {
      if (options.onOutputChunk(buffer, stream) === false) {
        cancel("output-limit");
      }
    } catch (error) {
      outputObserverError = error;
      cancel("output-limit");
    }
    return buffer;
  };

  child.stdout?.once("error", () => {
    outputErrorStream ??= "stdout";
  });
  child.stderr?.once("error", () => {
    outputErrorStream ??= "stderr";
  });

  child.stdout?.on("data", (chunk) => {
    const buffer = observeOutputChunk(chunk, "stdout");
    appendPreservedOutputLines({
      capture: stdoutCapture,
      chunk: buffer,
      stream: "stdout",
      preserveOutputLine: options.preserveOutputLine,
      maxPreservedOutputLines,
      maxPendingLineBytes: maxPreservedPendingLineBytes,
    });
    captureOutput(stdoutCapture, buffer, maxStdoutBytes, "stdout", stdoutCaptureMode);
    armNoOutputTimer();
  });
  child.stderr?.on("data", (chunk) => {
    const buffer = observeOutputChunk(chunk, "stderr");
    appendPreservedOutputLines({
      capture: stderrCapture,
      chunk: buffer,
      stream: "stderr",
      preserveOutputLine: options.preserveOutputLine,
      maxPreservedOutputLines,
      maxPendingLineBytes: maxPreservedPendingLineBytes,
    });
    captureOutput(stderrCapture, buffer, maxStderrBytes, "stderr", stderrCaptureMode);
    armNoOutputTimer();
  });

  const result = await child.finally(() => {
    commandSettled = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    clearNoOutputTimer();
    signal?.removeEventListener("abort", onAbort);
    releaseOutput();
  });
  await settleTerminatedProcessTree();
  if (outputObserverError !== undefined) {
    throw outputObserverError;
  }
  // Patched Node can report null/null after a cmd.exe shim exits. Execa turns
  // that into a cause-less failure; preserve the shim fallback only post-spawn.
  const isCauseLessWindowsShimResult =
    !termination &&
    invocation.usesWindowsExitCodeShim &&
    typeof child.pid === "number" &&
    result.code === undefined &&
    result.cause === undefined &&
    !result.timedOut &&
    !result.isCanceled &&
    !result.isMaxBuffer &&
    !result.isTerminated;
  if (isCauseLessWindowsShimResult) {
    // A patched Windows runtime can populate exitCode shortly after close.
    // Settle that state before the shim fallback can infer a clean exit.
    for (
      let elapsedMs = 0;
      elapsedMs < WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS;
      elapsedMs += WINDOWS_CLOSE_STATE_POLL_MS
    ) {
      if (
        childExitState?.code != null ||
        childExitState?.signal != null ||
        child.exitCode != null ||
        child.signalCode != null
      ) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WINDOWS_CLOSE_STATE_POLL_MS);
      });
    }
  }
  if (
    result.failed &&
    !termination &&
    !isPlainCommandExitFailure(result) &&
    !isPlainCommandSignalFailure(result) &&
    !isCauseLessWindowsShimResult &&
    !(
      result.exitCode === 0 &&
      outputErrorStream !== undefined &&
      options.tolerateOutputError?.[outputErrorStream] === true
    )
  ) {
    const error = createSanitizedCommandError(result);
    if (outputErrorStream) {
      Object.assign(error, { outputErrorStream });
    }
    throw error;
  }

  const resolvedSignal = result.signal ?? childExitState?.signal ?? child.signalCode ?? null;
  const resolvedCode = resolveProcessExitCode({
    explicitCode: result.exitCode ?? childExitState?.code,
    childExitCode: child.exitCode,
    resolvedSignal,
    usesWindowsExitCodeShim: invocation.usesWindowsExitCodeShim,
    timedOut: termination === "timeout",
    noOutputTimedOut: termination === "no-output-timeout",
    killIssuedByTimeout: termination === "timeout" || termination === "no-output-timeout",
    killIssuedByAbort: termination === "signal" || termination === "output-limit",
  });
  termination ??= resolvedSignal != null || result.isTerminated ? "signal" : "exit";
  const normalizedCode =
    termination === "timeout" || termination === "no-output-timeout"
      ? resolvedCode == null || resolvedCode === 0
        ? TIMEOUT_EXIT_CODE
        : resolvedCode
      : resolvedCode;

  flushPreservedOutputLine({
    capture: stdoutCapture,
    stream: "stdout",
    preserveOutputLine: options.preserveOutputLine,
    maxPreservedOutputLines,
    maxPendingLineBytes: maxPreservedPendingLineBytes,
  });
  flushPreservedOutputLine({
    capture: stderrCapture,
    stream: "stderr",
    preserveOutputLine: options.preserveOutputLine,
    maxPreservedOutputLines,
    maxPendingLineBytes: maxPreservedPendingLineBytes,
  });

  if (usesCombinedTailCapture) {
    for (const entry of combinedTailChunks) {
      const capture = entry.stream === "stdout" ? stdoutCapture : stderrCapture;
      capture.chunks.push(entry.buffer);
      capture.bytes += entry.buffer.byteLength;
    }
  }

  return {
    pid: child.pid,
    stdout: decodeWindowsOutputBuffer({
      buffer: finalizeCapturedOutput(stdoutCapture, stdoutCaptureMode),
      windowsEncoding,
    }),
    stderr: decodeWindowsOutputBuffer({
      buffer: finalizeCapturedOutput(stderrCapture, stderrCaptureMode),
      windowsEncoding,
    }),
    stdoutTruncatedBytes: stdoutCapture.truncatedBytes || undefined,
    stderrTruncatedBytes: stderrCapture.truncatedBytes || undefined,
    preservedStdoutLines:
      stdoutCapture.preservedLines.length > 0 ? stdoutCapture.preservedLines : undefined,
    preservedStderrLines:
      stderrCapture.preservedLines.length > 0 ? stderrCapture.preservedLines : undefined,
    code: normalizedCode,
    signal: resolvedSignal,
    killed: child.killed,
    termination: termination === "output-limit" ? "signal" : termination,
    noOutputTimedOut: termination === "no-output-timeout",
    outputLimitExceeded: termination === "output-limit" || undefined,
    ...(outputErrorStream ? { outputErrorStream } : {}),
  };
}
