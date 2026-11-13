import { ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { TLSSocket } from "node:tls";
import { drainProcessOutput } from "../process/output-drain.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, ExitError, restoreRuntimeTerminalState } from "../runtime.js";
import { waitForPendingCliDisposers } from "./runtime-cleanup.js";
import { waitForCliSignalExit } from "./signal-exit-barrier.js";

let requestedExitCode: number | "process" | undefined;
let settledExitWatchdog: { delayMs: number; terminateFailedExit: boolean } | undefined;

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
      // Final disposers can log after the Gateway's earlier flush. Join those writes before
      // bounding leftover handles; natural exit still avoids forcing V8 compiler teardown.
      if (settledExitWatchdog !== undefined) {
        await (await import("../logging/logger.js")).flushLogger();
        await new Promise<void>((resolve) => {
          drainProcessOutput(resolve);
        });
        armSettledExitWatchdog(settledExitWatchdog);
        settledExitWatchdog = undefined;
      }
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

/**
 * Long-lived owners retire their deadline watchdogs once shutdown settles. Ask the CLI to bound
 * a referenced handle nobody closed after every command-owned job, disposer and finalizer ends.
 */
export function requestSettledExitWatchdog(delayMs: number): void {
  settledExitWatchdog = { delayMs, terminateFailedExit: false };
}

/**
 * Finite maintenance commands have no supervisor restart status to preserve, and a shell is
 * waiting on them, so a referenced handle nobody closed cannot hold a failed outcome open either.
 */
export function requestOneShotSettledExitWatchdog(delayMs = 10_000): void {
  settledExitWatchdog = { delayMs, terminateFailedExit: true };
}

function armSettledExitWatchdog(params: { delayMs: number; terminateFailedExit: boolean }): void {
  const { delayMs, terminateFailedExit } = params;
  // Unref'd: a natural exit is never delayed.
  setTimeout(() => {
    const summarize = (names: string[]) => {
      const counts = new Map<string, number>();
      for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts].map(([name, count]) => `${name}x${count}`).join(", ") || "unreported";
    };
    const handles =
      // SAFETY: Node's diagnostic API returns handle objects; other runtimes may omit it.
      (process as NodeJS.Process & { _getActiveHandles?: () => object[] })["_getActiveHandles"]?.();
    const resources = summarize(process.getActiveResourcesInfo());
    const handleTypes = summarize(handles?.map((handle) => handle.constructor.name) ?? []);
    const handleDetails = handles?.slice(0, 8).map((handle) => {
      if (handle === process.stdout || handle === process.stderr) {
        return handle === process.stdout ? "stdout" : "stderr";
      }
      if (handle instanceof TLSSocket) {
        return { tls: (handle.servername || "").slice(0, 255), remote: handle.remoteAddress };
      }
      if (handle instanceof ChildProcess) {
        return { argv0: handle.spawnargs[0]?.slice(0, 255) };
      }
      return handle.constructor.name;
    });
    // Only a clean POSIX outcome is ended here unless the caller opted out; a non-zero status
    // can be a supervisor's restart instruction that no signal can carry, so it stays with the
    // supervisor.
    const terminate =
      process.platform !== "win32" && (terminateFailedExit || resolveProcessExitCode() === 0);
    writeSync(
      2,
      `command settled but the process is still alive after ${delayMs}ms; active resources: ${resources}; active handles: ${handleTypes}; handle details: ${JSON.stringify(handleDetails ?? [])}${terminate ? "; terminating" : ""}\n`,
    );
    if (terminate) {
      // Re-raise the stop signal with its default action: no Node exit teardown
      // (process.exit is banned) and supervisors record a clean stop.
      process.removeAllListeners("SIGTERM");
      process.kill(process.pid, "SIGTERM");
    }
  }, delayMs).unref();
}

/** Report unsettled cleanup without bypassing its native resource owner. */
export function watchCliExitAfterOutput(onStall: () => void): void {
  setTimeout(onStall, 10_000).unref();
}
