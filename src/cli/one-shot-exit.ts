import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, ExitError, restoreRuntimeTerminalState } from "../runtime.js";
import { waitForPendingCliDisposers } from "./runtime-cleanup.js";
import { waitForCliSignalExit } from "./signal-exit-barrier.js";

let requestedExitCode: number | "process" | undefined;

function resolveProcessExitCode(fallback = 0): number {
  const value = process.exitCode;
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : fallback;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return fallback;
}

export async function runCliWithExitFinalization(params: {
  run: () => Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
  /** Join caller-owned state after command cleanup and before process completion. */
  finalize?: () => Promise<void>;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  let finalizationFailure: { error: unknown } | undefined;
  try {
    await params.run();
  } catch (error) {
    if (error instanceof ExitError) {
      if (!requestExitAfterOneShotOutput(runtime, error.code)) {
        throw error;
      }
    } else {
      await params.onError(error);
      requestExitAfterOneShotOutput(runtime, resolveProcessExitCode(1));
    }
  } finally {
    let signalExitCode = await waitForCliSignalExit();
    if (runtime === defaultRuntime) {
      // A disposer warning is not completion. Native writers must settle before
      // finalizers close their databases, and before Node tears down the isolate.
      await waitForPendingCliDisposers();
    }
    if (params.finalize) {
      try {
        await params.finalize();
      } catch (error) {
        try {
          await params.onError(error);
        } catch (reportError) {
          finalizationFailure = { error: reportError };
        }
        if (!requestExitAfterOneShotOutput(runtime, 1)) {
          finalizationFailure ??= { error };
        }
      }
    }
    if (runtime === defaultRuntime) {
      await waitForPendingCliDisposers();
      signalExitCode = (await waitForCliSignalExit()) ?? signalExitCode;
      const requestedCode = requestedExitCode;
      requestedExitCode = undefined;
      if (signalExitCode !== undefined) {
        process.exitCode = signalExitCode;
      } else if (requestedCode !== undefined) {
        process.exitCode = requestedCode === "process" ? resolveProcessExitCode() : requestedCode;
      }
      if (signalExitCode !== undefined || requestedCode !== undefined) {
        // Explicit exits retain runtime.exit's terminal contract after owned cleanup.
        // Ordinary command completion must not add ANSI bytes to its output.
        restoreRuntimeTerminalState("CLI exit", { resumeStdinIfPaused: false });
      }
      // Node drains stdio and V8 compiler work naturally.
    }
  }
  // A cleanup failure must not replace an embedded runtime's original exit.
  if (finalizationFailure) {
    throw finalizationFailure.error;
  }
}

/** Unwind an already-reported CLI outcome before shared cleanup and output draining. */
export function exitCliAfterOutput(runtime: RuntimeEnv, exitCode: number): never {
  if (runtime !== defaultRuntime) {
    runtime.exit(exitCode);
  }
  throw new ExitError(exitCode);
}

export function requestExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  exitCode?: number,
): boolean {
  if (runtime !== defaultRuntime) {
    return false;
  }
  requestedExitCode = exitCode ?? "process";
  return true;
}

/** Report unsettled cleanup without bypassing its native resource owner. */
export function watchCliExitAfterOutput(onStall: () => void): void {
  setTimeout(onStall, 10_000).unref();
}
