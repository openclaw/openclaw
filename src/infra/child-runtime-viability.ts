import { spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";

export type ChildRuntimeRecovery = {
  status: "restart-requested" | "report-only";
  reason: string;
};

export type ChildRuntimeViability = {
  execPath: string;
  available: boolean;
};
const runtime = resolveGlobalSingleton(
  Symbol.for("openclaw.childRuntimeViability"),
  (): {
    initialPath: string;
    initialIdentity?: string;
    execPath?: string;
    failure?: Error;
    recoveryStarted?: boolean;
    recover?: () => Promise<ChildRuntimeRecovery>;
  } => ({
    initialPath: process.execPath,
    initialIdentity: executableIdentity(process.execPath),
  }),
);
const loaderFailure =
  /(?:dyld[^\n]*:\s*Library not loaded:|error while loading shared libraries:)/i;

const ambiguousLoaderFailure =
  /(?:dyld[^\n]*:\s*Symbol not found:|symbol lookup error:|Error loading shared library|version [`'"][^`'"\r\n]+[`'"] not found)/i;

function executableIdentity(execPath: string): string | undefined {
  try {
    const { dev, ino, size, mtimeMs, mode } = statSync(execPath);
    return `${dev}:${ino}:${size}:${mtimeMs}:${mode}`;
  } catch {
    return undefined;
  }
}

export function readChildRuntimeViability(params?: { execPath?: string }): ChildRuntimeViability {
  const execPath = params?.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return { execPath, available: false };
  }
  let available = true;
  try {
    accessSync(execPath, constants.X_OK);
  } catch (error) {
    available = !(hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR"));
    if (!available) {
      recordUnavailableRuntime(execPath, error);
    }
  }
  return { execPath, available };
}

/** The run loop owns recovery; runtime observations publish the first diagnosis. */
export function registerChildRuntimeRecovery(
  recover: () => Promise<ChildRuntimeRecovery>,
): () => void {
  runtime.recover = recover;
  recoverUnavailableRuntime();
  return () => {
    if (runtime.recover === recover) {
      runtime.recover = undefined;
    }
  };
}

function recoverUnavailableRuntime(): void {
  if (
    runtime.execPath !== process.execPath ||
    !runtime.failure ||
    !runtime.recover ||
    runtime.recoveryStarted
  ) {
    return;
  }
  runtime.recoveryStarted = true;
  const recover = runtime.recover;
  // Recovery must not inherit the failed worker's broker or cancellation scope.
  void runInDetachedAsyncContext(() =>
    Promise.resolve()
      .then(recover)
      .catch((): ChildRuntimeRecovery => ({
        status: "report-only",
        reason:
          "Automatic runtime recovery is report-only: service or restart preparation failed. Inspect the service runtime and restart through its owner.",
      }))
      .then((recovery) => {
        createSubsystemLogger("gateway/runtime").warn(`${recovery.status}: ${recovery.reason}`);
      }),
  );
}

/** A bounded bare-runtime probe, shared by diagnosis and restart target verification. */
export function probeChildRuntimeExecutable(
  execPath: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  return spawnSync(execPath, ["--version"], {
    encoding: "utf8",
    cwd: options.cwd ?? path.parse(process.execPath).root,
    env: options.env ?? { ...process.env, NODE_OPTIONS: undefined },
    timeout: 1_000,
    maxBuffer: 8_192,
  });
}

export function formatMissingChildRuntimeWarning(
  viability: ChildRuntimeViability,
): string | undefined {
  return viability.available
    ? undefined
    : `The Node.js runtime this Gateway started with (${sanitizeTerminalText(viability.execPath)}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`;
}

/** A permanent launch failure belongs to the runtime, not to any one worker pool. */
export function assertChildRuntimeAvailable(): void {
  if (runtime.execPath === process.execPath && runtime.failure) {
    throw runtime.failure;
  }
}

function recordUnavailableRuntime(execPath: string, cause?: unknown): Error {
  if (runtime.execPath === execPath && runtime.failure) {
    return runtime.failure;
  }
  runtime.execPath = execPath;
  runtime.failure = Object.assign(
    new Error(formatMissingChildRuntimeWarning({ execPath, available: false }), { cause }),
    { code: "NODE_RUNTIME_UNAVAILABLE" },
  );
  createSubsystemLogger("gateway/runtime").error(runtime.failure.message);
  recoverUnavailableRuntime();
  return runtime.failure;
}

export function classifyChildRuntimeFailure(params: {
  execPath?: string;
  error?: unknown;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  started?: boolean;
}): Error | undefined {
  if (params.started) {
    return undefined;
  }
  const execPath = params.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return runtime.failure;
  }
  let unavailable = loaderFailure.test(params.stderr ?? "");
  if (params.error && !readChildRuntimeViability({ execPath }).available) {
    unavailable = true;
  }
  if (
    !unavailable &&
    (params.error ||
      params.signal === "SIGABRT" ||
      ambiguousLoaderFailure.test(params.stderr ?? ""))
  ) {
    // IPC can fail before startup stderr arrives. Confirm the bare runtime;
    // ordinary crashes and worker-only native modules must not disable healthy Node.
    const probe = probeChildRuntimeExecutable(execPath);
    const changed =
      execPath !== runtime.initialPath || executableIdentity(execPath) !== runtime.initialIdentity;
    unavailable =
      loaderFailure.test(probe.stderr ?? "") ||
      ambiguousLoaderFailure.test(probe.stderr ?? "") ||
      hasErrnoCode(probe.error, "ENOENT") ||
      hasErrnoCode(probe.error, "ENOTDIR") ||
      (changed &&
        (probe.signal === "SIGABRT" ||
          hasErrnoCode(probe.error, "ENOEXEC") ||
          hasErrnoCode(probe.error, "EACCES") ||
          hasErrnoCode(probe.error, "EPERM")));
  }
  if (!unavailable) {
    return undefined;
  }
  return recordUnavailableRuntime(execPath, params.error);
}

/** Capture startup evidence; the owner reads the diagnosis after native completion. */
export function observeChildRuntime(
  child: ChildProcess,
  execPath = process.execPath,
): () => Error | undefined {
  let started = false;
  let error: unknown;
  let stderr = "";
  child.once("message", () => {
    started = true;
    stderr = "";
  });
  child.on("error", (cause) => {
    error ??= cause;
  });
  const captureStderr = (chunk: Buffer | string) => {
    if (!started) {
      stderr = (stderr + chunk.toString()).slice(-8_192);
    }
  };
  child.stderr?.on("data", captureStderr);
  return () =>
    child.exitCode === 0 && !error
      ? undefined
      : classifyChildRuntimeFailure({ execPath, error, stderr, signal: child.signalCode, started });
}

/** Missing commands and missing working directories are not runtime failures. */
export function formatChildRuntimeSpawnWarning(error: unknown): string | undefined {
  if (error instanceof Error && "path" in error && error.path === process.execPath) {
    return classifyChildRuntimeFailure({ error })?.message;
  }
  return undefined;
}
