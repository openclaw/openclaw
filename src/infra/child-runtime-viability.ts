import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
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
    return formatExecutableIdentity(statSync(execPath));
  } catch {
    return undefined;
  }
}

function formatExecutableIdentity({ dev, ino, size, mtimeMs, mode }: Stats): string {
  return `${dev}:${ino}:${size}:${mtimeMs}:${mode}`;
}

function publishRuntimeViability(execPath: string, error?: unknown): ChildRuntimeViability {
  if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
    recordUnavailableRuntime(execPath, error);
  }
  return { execPath, available: !(runtime.execPath === execPath && runtime.failure) };
}

/** Retained for the public synchronous readiness, OOM and SQLite contracts. */
export function readChildRuntimeViability(params?: { execPath?: string }): ChildRuntimeViability {
  const execPath = params?.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return { execPath, available: false };
  }
  try {
    accessSync(execPath, constants.X_OK);
  } catch (error) {
    return publishRuntimeViability(execPath, error);
  }
  return publishRuntimeViability(execPath);
}

/** Observe external runtime replacement without blocking the Gateway thread. */
export async function prepareChildRuntimeViability(params?: {
  execPath?: string;
}): Promise<{ publish: () => ChildRuntimeViability }> {
  const execPath = params?.execPath ?? process.execPath;
  let available = !(runtime.execPath === execPath && runtime.failure);
  if (available) {
    try {
      await fs.access(execPath, constants.X_OK);
    } catch (error) {
      available = publishRuntimeViability(execPath, error).available;
    }
  }
  return {
    publish: () => ({
      execPath,
      available: available && publishRuntimeViability(execPath).available,
    }),
  };
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

function runtimeProbeOptions(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  return {
    encoding: "utf8" as const,
    cwd: options.cwd ?? path.parse(process.execPath).root,
    env: options.env ?? { ...process.env, NODE_OPTIONS: undefined },
    timeout: 1_000,
    maxBuffer: 8_192,
  };
}

/** Native launch avoids recursing into the command owner's runtime diagnosis. */
export function probeChildRuntimeExecutable(
  execPath: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RuntimeProbe> {
  return new Promise((resolve) => {
    execFile(execPath, ["--version"], runtimeProbeOptions(options), (error, stdout, stderr) =>
      resolve({
        stdout,
        stderr,
        error: error ?? undefined,
        status: error ? (typeof error.code === "number" ? error.code : null) : 0,
        signal: error?.signal ?? null,
      }),
    );
  });
}

type RuntimeProbe = {
  stdout: string;
  stderr: string;
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
};

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

type RuntimeFailure = {
  execPath?: string;
  error?: unknown;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  started?: boolean;
};

function needsRuntimeProbe(params: RuntimeFailure): boolean {
  return Boolean(
    params.error || params.signal === "SIGABRT" || ambiguousLoaderFailure.test(params.stderr ?? ""),
  );
}

function classifyRuntimeProbe(
  execPath: string,
  probe: RuntimeProbe,
  identity: string | undefined,
  cause: unknown,
): Error | undefined {
  if (runtime.execPath === execPath && runtime.failure) {
    return runtime.failure;
  }
  const changed = execPath !== runtime.initialPath || identity !== runtime.initialIdentity;
  const unavailable =
    loaderFailure.test(probe.stderr) ||
    ambiguousLoaderFailure.test(probe.stderr) ||
    hasErrnoCode(probe.error, "ENOENT") ||
    hasErrnoCode(probe.error, "ENOTDIR") ||
    (changed &&
      (probe.signal === "SIGABRT" ||
        hasErrnoCode(probe.error, "ENOEXEC") ||
        hasErrnoCode(probe.error, "EACCES") ||
        hasErrnoCode(probe.error, "EPERM")));
  return unavailable ? recordUnavailableRuntime(execPath, cause) : undefined;
}

/** The public synchronous SQLite reader retains immediate failure classification. */
export function classifyChildRuntimeFailure(params: RuntimeFailure): Error | undefined {
  if (params.started) {
    return undefined;
  }
  const execPath = params.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return runtime.failure;
  }
  if (
    loaderFailure.test(params.stderr ?? "") ||
    (params.error && !readChildRuntimeViability({ execPath }).available)
  ) {
    return recordUnavailableRuntime(execPath, params.error);
  }
  if (!needsRuntimeProbe(params)) {
    return undefined;
  }
  const probe = spawnSync(execPath, ["--version"], runtimeProbeOptions());
  return classifyRuntimeProbe(
    execPath,
    probe,
    execPath === runtime.initialPath ? executableIdentity(execPath) : undefined,
    params.error,
  );
}

export async function prepareChildRuntimeFailure(
  params: RuntimeFailure,
): Promise<Error | undefined> {
  if (params.started) {
    return undefined;
  }
  const execPath = params.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return runtime.failure;
  }
  if (
    loaderFailure.test(params.stderr ?? "") ||
    (params.error && !(await prepareChildRuntimeViability({ execPath })).publish().available)
  ) {
    return recordUnavailableRuntime(execPath, params.error);
  }
  if (!needsRuntimeProbe(params)) {
    return undefined;
  }
  // IPC can fail before stderr arrives. Worker-only crashes must not disable healthy Node.
  const probe = await probeChildRuntimeExecutable(execPath);
  const identity =
    execPath === runtime.initialPath
      ? await fs.stat(execPath).then(formatExecutableIdentity, () => undefined)
      : undefined;
  return classifyRuntimeProbe(execPath, probe, identity, params.error);
}

/** Capture startup evidence; the owner reads the diagnosis after native completion. */
export function observeChildRuntime(
  child: ChildProcess,
  execPath = process.execPath,
): () => Promise<Error | undefined> {
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
  return async () =>
    child.exitCode === 0 && !error
      ? undefined
      : prepareChildRuntimeFailure({ execPath, error, stderr, signal: child.signalCode, started });
}

/** Missing commands and missing working directories are not runtime failures. */
export async function formatChildRuntimeSpawnWarning(error: unknown): Promise<string | undefined> {
  if (error instanceof Error && "path" in error && error.path === process.execPath) {
    return (await prepareChildRuntimeFailure({ error }))?.message;
  }
  return undefined;
}
