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
  if (params.platform === "win32") {
    const normalizedKey = params.key.toLowerCase();
    for (const existingKey of Object.keys(params.env)) {
      if (existingKey.toLowerCase() === normalizedKey && existingKey !== params.key) {
        delete params.env[existingKey];
      }
    }
  }
  if (params.value === undefined) {
    delete params.env[params.key];
    return;
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

// Simple promise-wrapped execFile with optional verbosity logging.
export async function runExec(
  command: string,
  args: string[],
  opts: number | { timeoutMs?: number; maxBuffer?: number; cwd?: string } = 10_000,
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
  const cwd = typeof opts === "number" ? undefined : opts.cwd;
  try {
    const subprocess = spawnCommand([command, ...args], {
      cwd,
      encoding: "buffer",
      forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
      maxBuffer,
      reject: true,
      stdin: "ignore",
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
    if (shouldLogVerbose()) {
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
    if (shouldLogVerbose()) {
      logError(danger(`Command failed: ${command} ${args.join(" ")}`));
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
};

export type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  maxPreservedOutputLines?: number;
  preserveOutputLine?: (line: string, stream: "stdout" | "stderr") => boolean;
  killProcessTree?: boolean;
};

const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;
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

function appendCapturedOutput(
  capture: CapturedOutputBuffers,
  chunk: Buffer | string,
  maxBytes: number,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
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
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
  const maxPreservedPendingLineBytes = Math.min(maxOutputBytes, MAX_PRESERVED_PENDING_LINE_BYTES);
  const maxPreservedOutputLines = Math.max(0, Math.floor(options.maxPreservedOutputLines ?? 16));
  const windowsEncoding = resolveWindowsConsoleEncoding();
  const cancelController = new AbortController();
  let termination: SpawnResult["termination"] | undefined;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let childExited = false;
  let noOutputTimer: NodeJS.Timeout | undefined;
  let processTreeForceKillTimer: NodeJS.Timeout | undefined;

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
  const clearProcessTreeForceKillTimer = () => {
    if (processTreeForceKillTimer) {
      clearTimeout(processTreeForceKillTimer);
      processTreeForceKillTimer = undefined;
    }
  };
  const killDirectChild = () => {
    if (!childExited && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  };
  const spawnTaskkillOrFallback = (args: string[], onSpawnError: () => void): boolean => {
    try {
      const taskkillChild = spawnCommand([getWindowsSystem32ExePath("taskkill.exe"), ...args], {
        baseEnv,
        env,
        reject: false,
        stdio: "ignore",
      });
      void taskkillChild.then((result) => {
        if (result.failed && result.exitCode === undefined) {
          onSpawnError();
        }
      });
      return true;
    } catch {
      onSpawnError();
      return false;
    }
  };
  const terminateChild = () => {
    if (childExited || child.exitCode != null || child.signalCode != null) {
      return;
    }
    if (process.platform === "win32" && typeof child.pid === "number") {
      if (killProcessTree) {
        const taskkillStarted = spawnTaskkillOrFallback(["/PID", String(child.pid), "/T"], () => {
          clearProcessTreeForceKillTimer();
          killDirectChild();
        });
        if (taskkillStarted) {
          processTreeForceKillTimer = setTimeout(() => {
            processTreeForceKillTimer = undefined;
            if (childExited || child.exitCode != null || child.signalCode != null) {
              return;
            }
            spawnTaskkillOrFallback(["/PID", String(child.pid), "/T", "/F"], killDirectChild);
          }, COMMAND_PROCESS_TREE_KILL_GRACE_MS);
          processTreeForceKillTimer.unref();
        }
      } else {
        spawnTaskkillOrFallback(["/PID", String(child.pid), "/T", "/F"], killDirectChild);
      }
    } else if (killProcessTree && typeof child.pid === "number") {
      terminateProcessTree(child.pid, { graceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS });
    }
  };
  const cancel = (reason: Exclude<SpawnResult["termination"], "exit">) => {
    if (termination || childExited) {
      return;
    }
    termination = reason;
    terminateChild();
    // Windows tree termination is owned by trusted taskkill. Aborting Execa here
    // would terminate only the direct child before the tree gets its grace period.
    if (process.platform !== "win32" || typeof child.pid !== "number") {
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
    if (resolvedNoOutputTimeoutMs === undefined || childExited) {
      return;
    }
    clearNoOutputTimer();
    noOutputTimer = setTimeout(() => cancel("no-output-timeout"), resolvedNoOutputTimeoutMs);
  };

  const timeoutTimer = setTimeout(() => cancel("timeout"), resolvedTimeoutMs);
  const onAbort = () => cancel("signal");
  signal?.addEventListener("abort", onAbort, { once: true });
  armNoOutputTimer();

  child.stdout?.on("data", (chunk) => {
    appendPreservedOutputLines({
      capture: stdoutCapture,
      chunk,
      stream: "stdout",
      preserveOutputLine: options.preserveOutputLine,
      maxPreservedOutputLines,
      maxPendingLineBytes: maxPreservedPendingLineBytes,
    });
    appendCapturedOutput(stdoutCapture, chunk, maxOutputBytes);
    armNoOutputTimer();
  });
  child.stderr?.on("data", (chunk) => {
    appendPreservedOutputLines({
      capture: stderrCapture,
      chunk,
      stream: "stderr",
      preserveOutputLine: options.preserveOutputLine,
      maxPreservedOutputLines,
      maxPendingLineBytes: maxPreservedPendingLineBytes,
    });
    appendCapturedOutput(stderrCapture, chunk, maxOutputBytes);
    armNoOutputTimer();
  });

  const result = await child.finally(() => {
    clearTimeout(timeoutTimer);
    clearNoOutputTimer();
    clearProcessTreeForceKillTimer();
    signal?.removeEventListener("abort", onAbort);
    releaseOutput();
  });
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
    result.exitCode === undefined &&
    result.signal === undefined &&
    !isCauseLessWindowsShimResult
  ) {
    if (result instanceof Error) {
      throw result;
    }
    throw new Error(`Failed to launch command: ${argv[0] ?? "<empty>"}`, { cause: result });
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
    killIssuedByAbort: termination === "signal",
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

  return {
    pid: child.pid,
    stdout: decodeWindowsOutputBuffer({
      buffer: Buffer.concat(stdoutCapture.chunks, stdoutCapture.bytes),
      windowsEncoding,
    }),
    stderr: decodeWindowsOutputBuffer({
      buffer: Buffer.concat(stderrCapture.chunks, stderrCapture.bytes),
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
    termination,
    noOutputTimedOut: termination === "no-output-timeout",
  };
}
