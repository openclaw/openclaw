import {
  collectNestedErrorCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const commandCleanupUncertain = Symbol.for("openclaw.command-cleanup-uncertain");
const commandCleanupMessage = "Command cleanup could not confirm that owned work stopped";

function isCanonicalCommandProcessCleanupError(candidate: unknown): boolean {
  try {
    return Object.getOwnPropertyDescriptor(candidate, commandCleanupUncertain)?.value === true;
  } catch {
    return false;
  }
}

/** An admitted command may still write; callers must retain its artifacts for recovery. */
export class CommandProcessCleanupError extends Error {
  readonly code = "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN";
  readonly cleanup = "uncertain";

  constructor(options?: ErrorOptions) {
    let message = commandCleanupMessage;
    // Preserve the first canonical remedy without exposing unrelated cause text.
    for (const candidate of collectNestedErrorCandidates(options?.cause)) {
      if (!isCanonicalCommandProcessCleanupError(candidate)) {
        continue;
      }
      try {
        const detail: unknown = Object.getOwnPropertyDescriptor(candidate, "message")?.value;
        if (typeof detail === "string" && detail.trim() && detail !== commandCleanupMessage) {
          message = detail;
          break;
        }
      } catch {
        // Opaque causes must not prevent cleanup classification.
      }
    }
    super(message, options);
    this.name = "CommandProcessCleanupError";
    Object.defineProperty(this, commandCleanupUncertain, { value: true });
  }
}

/** Preserve canonical cleanup classification across cause chains and module copies. */
export function hasCommandProcessCleanupError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(isCanonicalCommandProcessCleanupError);
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
  /** The runner accepted cancellation and requested termination, independent of the OS signal. */
  killIssuedByAbort?: boolean;
  /** Completion of this invocation's cleanup; never an escaped-descendant inventory. */
  cleanup?: "normal" | "cooperative" | "forced" | "uncertain";
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  noOutputTimedOut?: boolean;
  outputLimitExceeded?: boolean;
  outputErrorStream?: "stdout" | "stderr";
};

export type CommandProcessOutcome = Pick<
  SpawnResult,
  "pid" | "code" | "cleanup" | "termination"
> & {
  /** False only while a managed beforeInput callback has withheld every input byte. */
  inputReleased?: boolean;
};
const commandFailureOutcome = Symbol.for("openclaw.command-process-outcome");

/** Lifecycle facts stay private; callers retain the original error and its diagnostics. */
export function recordCommandProcessFailure(error: unknown, outcome: CommandProcessOutcome): Error {
  const failure = toErrorObject(error, "Command failed");
  const target = Object.isExtensible(failure)
    ? failure
    : new Error(failure.message, { cause: failure });
  return Object.defineProperty(target, commandFailureOutcome, {
    value: Object.freeze({ ...outcome }),
    configurable: true,
  });
}

export function readCommandProcessFailure(error: unknown): CommandProcessOutcome | undefined {
  for (const cause of collectNestedErrorCandidates(error)) {
    try {
      const outcome: unknown = isRecord(cause)
        ? Object.getOwnPropertyDescriptor(cause, commandFailureOutcome)?.value
        : undefined;
      if (
        isRecord(outcome) &&
        (outcome.pid === undefined ||
          (typeof outcome.pid === "number" &&
            Number.isSafeInteger(outcome.pid) &&
            outcome.pid > 0)) &&
        (outcome.code === null || typeof outcome.code === "number") &&
        (outcome.inputReleased === undefined || typeof outcome.inputReleased === "boolean") &&
        (outcome.cleanup === undefined ||
          outcome.cleanup === "normal" ||
          outcome.cleanup === "cooperative" ||
          outcome.cleanup === "forced" ||
          outcome.cleanup === "uncertain") &&
        (outcome.termination === "exit" ||
          outcome.termination === "signal" ||
          outcome.termination === "timeout" ||
          outcome.termination === "no-output-timeout")
      ) {
        return {
          pid: outcome.pid,
          code: outcome.code,
          cleanup: outcome.cleanup,
          termination: outcome.termination,
          inputReleased: outcome.inputReleased,
        };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const TIMEOUT_EXIT_CODE = 124;

export function createSanitizedCommandError(result: {
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

type CommandFailure = {
  failed: boolean;
  exitCode?: unknown;
  signal?: unknown;
  cause?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
};

export function isPlainCommandExitFailure(result: CommandFailure): boolean {
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

export function isPlainCommandSignalFailure(result: CommandFailure): boolean {
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
