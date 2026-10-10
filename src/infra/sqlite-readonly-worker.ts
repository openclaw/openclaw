import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { formatByteSize } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { resolveForwardedExitCompilerArgs } from "../bootstrap/node-exit-safe-compilers.js";
import { resolveStateDir } from "../config/state-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getSpawnBroker } from "../process/spawn-broker/context.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { hasErrnoCode } from "./errno.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { tryProcessCwd } from "./safe-cwd.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import type { SqliteReadOnlyOperations } from "./sqlite-readonly-operation-registry.js";
import {
  readOnlyWorkerScope,
  type SqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker-context.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  readSqliteReadOnlyWorkerValue,
  sqliteReadOnlyWorkerRequestArgs,
  type SqliteReadOnlyWorkerOptions,
  type SqliteReadOnlyWorkerOutput,
  type SqliteReadOnlyWorkerValue,
  type SqliteAuthProfileReadOptions,
  type SqliteReadOnlyOperationOptions,
  type SqliteAuthProfileRows,
} from "./sqlite-readonly-worker-protocol.js";
import {
  createSqliteReadOnlyWorkerSession,
  isSameSqliteReadOnlyWorkerLaunch,
  type SqliteReadOnlyWorkerLaunch,
} from "./sqlite-readonly-worker-session.js";
import { classifyWorkerRequest, trackWorkerRequest } from "./worker-request-diagnostics.js";

const SLOW_HARDWARE_HEADROOM = 10;
const SQLITE_INSPECTION_TIMEOUT_MS = 30_000 * SLOW_HARDWARE_HEADROOM;
const SQLITE_INSPECTION_BYTES_PER_SECOND = 32 * 1024 * 1024;
const log = createSubsystemLogger("state/sqlite");

export function resolveSqliteInspectionBudget(
  operation: string,
  pathname: string,
  sizeBytes: number | bigint | undefined,
): { timeoutMs: number; size: string } {
  // Copy reads source and writes private files; comparison reads both again.
  // Leave tenfold headroom below the cloud-storage rate for old, slow disks.
  const timeoutMs = resolveTimerTimeoutMs(
    SQLITE_INSPECTION_TIMEOUT_MS +
      Math.ceil(
        (4 * SLOW_HARDWARE_HEADROOM * Number(sizeBytes ?? 0)) / SQLITE_INSPECTION_BYTES_PER_SECOND,
      ) *
        1000,
    SQLITE_INSPECTION_TIMEOUT_MS,
  );
  const size =
    sizeBytes === undefined
      ? "unknown size"
      : formatByteSize(Number(sizeBytes), {
          style: "iec",
          maxUnit: "giga",
          separator: " ",
          fractionDigits: sizeBytes < 1024n ? 0 : 1,
        });
  if (timeoutMs > SQLITE_INSPECTION_TIMEOUT_MS) {
    log.debug(`SQLite ${operation} for ${pathname}: ${size}, budget ${timeoutMs / 1000} seconds`);
  }
  return { timeoutMs, size };
}

/** Sum serial SQLite inspection budgets without overflowing Node timers. */
export function resolveAggregateSqliteInspectionTimeoutMs(
  operation: string,
  databases: readonly { path: string; sizeBytes: bigint | undefined }[],
): number {
  let timeoutMs = 0;
  for (const database of databases) {
    timeoutMs += resolveSqliteInspectionBudget(
      operation,
      database.path,
      database.sizeBytes,
    ).timeoutMs;
  }
  return resolveTimerTimeoutMs(
    timeoutMs,
    SQLITE_INSPECTION_TIMEOUT_MS,
    SQLITE_INSPECTION_TIMEOUT_MS,
  );
}

export function readSqliteInspectionBudget(
  operation: string,
  pathname: string,
  mainSizeBytes?: bigint,
): { timeoutMs: number; size: string } {
  let sizeBytes = mainSizeBytes;
  try {
    sizeBytes ??= fs.statSync(pathname, { bigint: true }).size;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        sizeBytes += fs.statSync(pathname + suffix, { bigint: true }).size;
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  } catch {
    // Let the child report the source error with its normal diagnostics.
  }
  return resolveSqliteInspectionBudget(operation, pathname, sizeBytes);
}

export function sqliteInspectionTimeoutError(
  operation: string,
  pathname: string,
  timeoutMs: number,
  size: string,
): Error {
  return new Error(
    `SQLite ${operation} timed out after ${timeoutMs / 1000} seconds (budget for ${size}) for ${pathname}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance.`,
  );
}

/** Reuse child imports until the lifecycle owner closes; reads reacquire source admission. */
export function createSqliteReadOnlyWorkerScope(options?: {
  signal: AbortSignal;
  deadlineOwnedByCaller: boolean;
}) {
  const scope: SqliteReadOnlyWorkerScope = {
    active: true,
    busy: false,
    controller: new AbortController(),
    pending: new Set(),
    deadlineOwnedByCaller: options?.deadlineOwnedByCaller ?? false,
    readTail: Promise.resolve(),
  };
  const abort = () => scope.controller.abort(options?.signal.reason);
  options?.signal.addEventListener("abort", abort, { once: true });
  if (options?.signal.aborted) {
    abort();
  }
  let closing: Promise<void> | undefined;
  return {
    run<T>(operation: () => T): T {
      return readOnlyWorkerScope.run(scope, operation);
    },
    close(): Promise<void> {
      closing ??= (async () => {
        options?.signal.removeEventListener("abort", abort);
        scope.active = false;
        scope.controller.abort(new Error("SQLite read-only worker scope closed"));
        await Promise.allSettled(scope.pending);
        const closed = await Promise.allSettled([
          scope.worker?.close(),
          scope.readWorker?.session.close(),
        ]);
        const failures = closed.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "SQLite read-only worker scope cleanup failed");
        }
      })();
      return closing;
    },
  };
}

export async function withSqliteReadOnlyWorkerScope<T>(
  operation: () => Promise<T>,
  options?: { signal: AbortSignal; deadlineOwnedByCaller: boolean },
): Promise<T> {
  if (!options && readOnlyWorkerScope.getStore()?.active) {
    return operation();
  }
  const scope = createSqliteReadOnlyWorkerScope(options);
  try {
    return await scope.run(operation);
  } finally {
    await scope.close();
  }
}

/** A retained startup inspection is cancelled by its Gateway, not by its foreground wait. */
export function isSqliteInspectionDeadlineOwnedByCaller(): boolean {
  return readOnlyWorkerScope.getStore()?.deadlineOwnedByCaller === true;
}

export function resolveSqliteInspectionSignal(signal?: AbortSignal): AbortSignal | undefined {
  const scope = readOnlyWorkerScope.getStore();
  return scope
    ? signal
      ? AbortSignal.any([signal, scope.controller.signal])
      : scope.controller.signal
    : signal;
}

/** Bind a one-shot inspection to the active scope's cancellation and close join. */
export function runScopedSqliteInspection<T>(
  signal: AbortSignal | undefined,
  inspect: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const scope = readOnlyWorkerScope.getStore();
  if (!scope) {
    return inspect(signal);
  }
  if (!scope.active) {
    return Promise.reject(new Error("SQLite read-only worker scope closed"));
  }
  const scopedSignal = signal
    ? AbortSignal.any([signal, scope.controller.signal])
    : scope.controller.signal;
  const operation = inspect(scopedSignal);
  scope.pending.add(operation);
  void operation.then(
    () => scope.pending.delete(operation),
    () => scope.pending.delete(operation),
  );
  return operation;
}

function sqliteReadOnlyWorkerArgv(pathname: string, options: SqliteReadOnlyWorkerOptions) {
  const { moduleUrl, runtimeGeneration } = captureRuntimeWorkerSource(
    resolveRuntimeWorkerUrl(
      options.mode === "content-version"
        ? runtimeProcessEntrypoints.sqliteSourceRevision
        : runtimeProcessEntrypoints.sqliteReadOnly,
    ),
  );
  return {
    runtimeGeneration,
    argv: [
      ...resolveForwardedExitCompilerArgs(),
      ...resolveRuntimeWorkerArgv(moduleUrl),
      SQLITE_READONLY_CHILD_ARG,
      ...sqliteReadOnlyWorkerRequestArgs(pathname, options),
    ],
  };
}

/** Capture launch facts before awaiting another session's retirement. */
export function captureSqliteReadOnlyWorkerLaunch(
  env?: NodeJS.ProcessEnv,
  source?: SqliteAuthProfileReadOptions["source"],
): SqliteReadOnlyWorkerLaunch {
  // Snapshots require native process close before byte cleanup; canonical reads use a broker.
  const broker = source === "canonical" ? getSpawnBroker() : undefined;
  return {
    runtimeGeneration: captureRuntimeWorkerSource(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly),
    ).runtimeGeneration,
    env: {
      ...resolveNodeCompileCacheEnv(env),
      // Auth readers pin this default explicitly; equivalent roots share one child.
      OPENCLAW_STATE_DIR: resolveStateDir(env),
    },
    cwd: tryProcessCwd() ?? tmpdir(),
    transport: broker ? { kind: "broker", owner: broker } : { kind: "native" },
  };
}

export function createScopedSqliteReadOnlyWorker(
  launch: ReturnType<typeof captureSqliteReadOnlyWorkerLaunch> & {
    retainLifetime?: boolean;
    retainOnOperationError?: boolean;
  },
): ReturnType<typeof createSqliteReadOnlyWorkerSession> {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  // Launch facts are captured by the caller; the reusable child belongs to its scope.
  return runInDetachedAsyncContext(() =>
    createSqliteReadOnlyWorkerSession({
      ...launch,
      argv: [
        ...resolveRuntimeWorkerArgv(launch.runtimeGeneration?.resolve(workerUrl) ?? workerUrl),
        SQLITE_READONLY_CHILD_ARG,
        "session",
      ],
      requestArgs: sqliteReadOnlyWorkerRequestArgs,
      readBudget: (pathname) => readSqliteInspectionBudget("read-only snapshot", pathname),
      // Detached staging ownership retains its own budget inside caller-owned inspection scopes.
      deadlineOwnedByCaller:
        launch.retainLifetime === false ? () => false : isSqliteInspectionDeadlineOwnedByCaller,
      timeoutError: (pathname, timeoutMs, size) =>
        sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size),
      closeTimeoutMs: SQLITE_INSPECTION_TIMEOUT_MS,
    }),
  );
}

export async function runSqliteReadOnlyOperation<Key extends keyof SqliteReadOnlyOperations>(
  pathname: string,
  command: { type: Key; input: SqliteReadOnlyOperations[Key]["input"] },
  options: Omit<SqliteReadOnlyOperationOptions, "mode" | "command">,
): Promise<SqliteReadOnlyOperations[Key]["output"]> {
  const capturedCommand = structuredClone(command);
  const result = await runSqliteReadOnlyWorker(pathname, {
    ...options,
    mode: "operation",
    command: capturedCommand,
  });
  if (
    typeof result !== "object" ||
    !("operation" in result) ||
    result.operation !== capturedCommand.type
  ) {
    throw new Error("SQLite read-only worker returned a different operation");
  }
  // SAFETY: The registered handler and validated transfer envelope bind this command to its result.
  return result.value as SqliteReadOnlyOperations[Key]["output"];
}

export function runSqliteReadOnlyWorker(
  pathname: string,
  options: SqliteReadOnlyOperationOptions,
): Promise<SqliteReadOnlyWorkerValue>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: SqliteAuthProfileReadOptions,
): Promise<SqliteAuthProfileRows>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: {
    mode: "sync" | "async";
    stagingRoot?: string;
    signal?: AbortSignal;
  },
): Promise<string>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "consolidated"; stagingRoot: string; signal?: AbortSignal },
): Promise<string>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "reclaim"; signal?: AbortSignal },
): Promise<string[]>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  inputOptions: SqliteReadOnlyWorkerOptions,
): Promise<SqliteReadOnlyWorkerValue> {
  const options: SqliteReadOnlyWorkerOptions =
    (inputOptions.mode === "auth-profile-rows" || inputOptions.mode === "operation") &&
    isArtifactPreservingStateRead("agent", pathname)
      ? { ...inputOptions, artifactPreserving: true }
      : inputOptions;
  if (options.mode === "reclaim") {
    // Shared reclamation belongs to the allocation owner, not its first caller's scope.
    return readOnlyWorkerScope.exit(() => runSqliteReadOnlyWorkerOnce(pathname, options));
  }
  return runScopedSqliteInspection(options.signal, (signal) => {
    const scope = readOnlyWorkerScope.getStore();
    if (!scope) {
      return runSqliteReadOnlyWorkerOnce(pathname, options);
    }
    const scopedOptions = { ...options, signal };
    // Native backups can stall with persistent IPC on Node 26. Only artifact-
    // preserving raw sync reads reuse a child; backups and concurrent readers
    // stay one-shot, preserving POSIX source-lock isolation.
    const useScopedWorker = options.mode === "sync" && !scope.busy;
    if (useScopedWorker) {
      scope.busy = true;
    }
    if (scopedOptions.mode === "auth-profile-rows" || scopedOptions.mode === "operation") {
      const launch = captureSqliteReadOnlyWorkerLaunch(scopedOptions.env, scopedOptions.source);
      const observation = trackSqliteRead(scopedOptions);
      const operation = scope.readTail.then(() =>
        runSqliteScopedReadWorker(pathname, scopedOptions, launch, scope, observation),
      );
      // Source locks are process-owned. Keep admitted reads serial even for different databases.
      scope.readTail = runInDetachedAsyncContext(() =>
        operation.then(
          () => {},
          () => {},
        ),
      );
      return operation;
    }
    return (async () => {
      if (!useScopedWorker) {
        return runSqliteReadOnlyWorkerOnce(pathname, scopedOptions);
      }
      try {
        const launch = captureSqliteReadOnlyWorkerLaunch();
        if (!scope.worker?.compatible(launch)) {
          await scope.worker?.close();
          scopedOptions.signal?.throwIfAborted();
          scope.worker = createScopedSqliteReadOnlyWorker(launch);
        }
        return await scope.worker.run(pathname, scopedOptions);
      } finally {
        scope.busy = false;
      }
    })();
  });
}

function trackSqliteRead(options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions) {
  return trackWorkerRequest(
    "sqlite_read",
    classifyWorkerRequest(options.mode === "operation" ? options.command.type : options.mode),
    options.signal,
  );
}

async function runSqliteScopedReadWorker(
  pathname: string,
  options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions,
  launch: SqliteReadOnlyWorkerLaunch,
  scope?: SqliteReadOnlyWorkerScope,
  observation = trackSqliteRead(options),
): Promise<SqliteReadOnlyWorkerValue> {
  try {
    options.signal?.throwIfAborted();
    observation.started();
    if (
      scope?.readWorker &&
      (scope.readWorker.source !== options.source ||
        !isSameSqliteReadOnlyWorkerLaunch(scope.readWorker.launch, launch) ||
        scope.readWorker.session.isRetired())
    ) {
      await scope.readWorker.session.close();
      scope.readWorker = undefined;
      options.signal?.throwIfAborted();
    }
    let worker = scope?.readWorker?.session ?? createScopedSqliteReadOnlyWorker(launch);
    while (true) {
      if (scope) {
        // A confirmed native replacement still belongs to this captured broker request.
        scope.readWorker = { source: options.source, launch, session: worker };
      }
      let value: SqliteReadOnlyWorkerValue;
      try {
        value = await worker.run(pathname, options);
        options.signal?.throwIfAborted();
      } catch (error) {
        let cleanupFailure: { error: unknown } | undefined;
        try {
          await worker.close();
          if (scope) {
            scope.readWorker = undefined;
          }
        } catch (cleanupError) {
          cleanupFailure = { error: cleanupError };
        }
        if (cleanupFailure) {
          throw new AggregateError(
            [error, cleanupFailure.error],
            options.mode === "auth-profile-rows"
              ? "Auth read and child cleanup failed"
              : "SQLite read and child cleanup failed",
            { cause: error },
          );
        }
        if (worker.notStarted && hasErrnoCode(error, "ERR_SPAWN_BROKER_UNAVAILABLE")) {
          options.signal?.throwIfAborted();
          // A confirmed refusal has no child to replay. Preserve the captured launch context.
          worker = worker.createNativeReplacement();
          continue;
        }
        throw error;
      }
      if (!scope) {
        await worker.close();
      }
      options.signal?.throwIfAborted();
      return value;
    }
  } finally {
    observation.completed();
  }
}

export function runSqliteReadOnlyWorkerOnce(
  pathname: string,
  options: SqliteReadOnlyWorkerOptions,
  launch?: Pick<SqliteReadOnlyWorkerLaunch, "env" | "cwd"> & {
    deadlineOwnedByCaller?: boolean;
  },
): Promise<SqliteReadOnlyWorkerValue> {
  if (options.mode === "auth-profile-rows" || options.mode === "operation") {
    // CLI and bounded readers without a lifecycle owner must join their child before returning.
    return runSqliteScopedReadWorker(
      pathname,
      options,
      captureSqliteReadOnlyWorkerLaunch(options.env, options.source),
    );
  }
  const reclaim = options.mode === "reclaim";
  const { argv, runtimeGeneration } = sqliteReadOnlyWorkerArgv(pathname, options);
  return runOneShotSqliteInspection({
    pathname,
    operation: reclaim ? "reclamation" : "read-only snapshot",
    argv,
    runtimeGeneration,
    signal: options.signal,
    deadlineOwnedByCaller:
      !reclaim && (launch?.deadlineOwnedByCaller ?? isSqliteInspectionDeadlineOwnedByCaller()),
    deadlineStopsOwner: reclaim,
    env: launch?.env,
    cwd: launch?.cwd,
    stoppedFailure: "snapshot owner stopped",
    ...(reclaim ? { interrupt: (child: ChildProcess) => child.stdin?.end() } : {}),
    read: (output, deadlineReached) => {
      if (reclaim) {
        const warnings = readSqliteReadOnlyWorkerValue(output, "reclaim");
        if (deadlineReached) {
          const { timeoutMs, size } = readSqliteInspectionBudget("reclamation", pathname);
          warnings.push(
            sqliteInspectionTimeoutError("reclamation", pathname, timeoutMs, size).message,
          );
        }
        return warnings;
      }
      options.signal?.throwIfAborted();
      return readSqliteReadOnlyWorkerValue(output, options.mode);
    },
  });
}

export function runOneShotSqliteInspection<T>(params: {
  pathname: string;
  operation: string;
  argv: string[];
  runtimeGeneration?: ReturnType<typeof captureRuntimeWorkerSource>["runtimeGeneration"];
  signal?: AbortSignal;
  deadlineOwnedByCaller?: boolean;
  deadlineStopsOwner?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stoppedFailure: string;
  interrupt?: (child: ChildProcess) => void;
  read: (
    output: Extract<SqliteReadOnlyWorkerOutput, { kind: "launched" }>,
    deadlineReached: boolean,
  ) => T;
}): Promise<T> {
  const { timeoutMs, size } = readSqliteInspectionBudget(params.operation, params.pathname);
  return new Promise<T>((resolve, reject) => {
    let output: Extract<SqliteReadOnlyWorkerOutput, { kind: "launched" }> = {
      kind: "launched",
      stderr: "",
      stdout: "",
      status: null,
    };
    let stopped = false;
    let deadlineReached = false;
    const child = execFile(
      process.execPath,
      params.argv,
      {
        encoding: "utf8",
        env: params.env ?? resolveNodeCompileCacheEnv(),
        cwd: params.cwd,
        maxBuffer: SQLITE_READONLY_WORKER_MAX_BUFFER,
        timeout: params.deadlineStopsOwner || params.deadlineOwnedByCaller ? undefined : timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        const timedOut = error?.killed && error.signal === "SIGKILL" && error.code == null;
        if (timedOut) {
          deadlineReached = true;
        }
        output = {
          kind: "launched",
          status: child.exitCode,
          failure: error
            ? stopped
              ? params.stoppedFailure
              : timedOut
                ? sqliteInspectionTimeoutError(params.operation, params.pathname, timeoutMs, size)
                    .message
                : `exited unsuccessfully: ${error.message}`
            : undefined,
          stderr,
          stdout,
          cause: error ?? undefined,
        };
      },
    );
    const interrupt = () => {
      if (params.interrupt) {
        params.interrupt(child);
      } else {
        child.kill("SIGKILL");
      }
    };
    const abort = () => {
      if (!stopped) {
        stopped = true;
        interrupt();
      }
    };
    const timer = params.deadlineStopsOwner
      ? setTimeout(() => {
          deadlineReached = true;
          stopped = true;
          interrupt();
        }, timeoutMs)
      : undefined;
    const closed = retainSnapshotWork(
      new Promise<void>((resolveClosed) => {
        child.once("close", () => resolveClosed());
      }),
      abort,
    );
    params.runtimeGeneration?.retain(child, async () => {
      await closed;
    });
    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) {
      abort();
    }
    // execFile can report an abort/error before close. Ownership ends only
    // after the process and its pipes have closed, including failed launches.
    child.once("close", () => {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", abort);
      try {
        resolve(params.read(output, deadlineReached));
      } catch (workerError) {
        reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
      }
    });
  });
}

export function runSqliteReadOnlyWorkerSync(
  pathname: string,
  stagingRoot: string | undefined,
  mode: "sync" | "content-version" = "sync",
): string {
  const { timeoutMs, size } = readSqliteInspectionBudget("read-only snapshot", pathname);
  const started = log.isEnabled("trace") ? performance.now() : undefined;
  const result = spawnSync(
    process.execPath,
    sqliteReadOnlyWorkerArgv(pathname, { mode, stagingRoot }).argv,
    {
      encoding: "utf8",
      env: resolveNodeCompileCacheEnv(),
      maxBuffer: SQLITE_READONLY_WORKER_MAX_BUFFER,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (started !== undefined) {
    log.trace(`SQLite read-only snapshot child durationMs=${performance.now() - started}`);
  }
  // A spawnSync error does not carry a readable result; Node may not have created its pipes.
  const output: SqliteReadOnlyWorkerOutput = result.error
    ? {
        kind: "launch-failed",
        error: new Error(
          hasErrnoCode(result.error, "ETIMEDOUT")
            ? sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size).message
            : `SQLite read-only worker failed to start for ${pathname}: ${result.error.message}`,
          { cause: result.error },
        ),
      }
    : {
        kind: "launched",
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
        failure:
          result.status === 0
            ? undefined
            : `exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`,
      };
  return readSqliteReadOnlyWorkerValue(output, mode);
}
