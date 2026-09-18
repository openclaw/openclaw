import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatByteSize } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errno.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  readSqliteReadOnlyWorkerValue,
  type SqliteReadOnlyWorkerOptions,
  type SqliteReadOnlyWorkerOutput,
  type SqliteReadOnlyWorkerValue,
  type SqliteAuthProfileReadOptions,
  type SqliteAuthProfileRows,
} from "./sqlite-readonly-worker-protocol.js";
import { createSqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session.js";

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

type SqliteReadOnlyWorkerScope = {
  active: boolean;
  busy: boolean;
  controller: AbortController;
  pending: Set<Promise<SqliteReadOnlyWorkerValue>>;
  deadlineOwnedByCaller: boolean;
  worker?: ReturnType<typeof createScopedSqliteReadOnlyWorker>;
};
const readOnlyWorkerScope = new AsyncLocalStorage<SqliteReadOnlyWorkerScope>();

/** Reuse only a child process's imports; every inspection reacquires source admission. */
export async function withSqliteReadOnlyWorkerScope<T>(
  operation: () => Promise<T>,
  options?: { signal: AbortSignal; deadlineOwnedByCaller: boolean },
): Promise<T> {
  if (!options && readOnlyWorkerScope.getStore()?.active) {
    return operation();
  }
  const scope: SqliteReadOnlyWorkerScope = {
    active: true,
    busy: false,
    controller: new AbortController(),
    pending: new Set(),
    deadlineOwnedByCaller: options?.deadlineOwnedByCaller ?? false,
  };
  const abort = () => scope.controller.abort(options?.signal.reason);
  options?.signal.addEventListener("abort", abort, { once: true });
  if (options?.signal.aborted) {
    abort();
  }
  try {
    return await readOnlyWorkerScope.run(scope, operation);
  } finally {
    options?.signal.removeEventListener("abort", abort);
    scope.active = false;
    scope.controller.abort(new Error("SQLite read-only worker scope closed"));
    await Promise.allSettled(scope.pending);
    await scope.worker?.close();
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

function sqliteReadOnlyWorkerRequestArgs(pathname: string, options: SqliteReadOnlyWorkerOptions) {
  return [
    options.mode,
    path.resolve(pathname),
    ...(options.stagingRoot ? [options.stagingRoot] : []),
  ];
}

function sqliteReadOnlyWorkerArgv(pathname: string, options: SqliteReadOnlyWorkerOptions) {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  return [
    ...resolveRuntimeWorkerArgv(workerUrl),
    SQLITE_READONLY_CHILD_ARG,
    ...sqliteReadOnlyWorkerRequestArgs(pathname, options),
  ];
}

function captureSqliteReadOnlyWorkerLaunch(env?: NodeJS.ProcessEnv) {
  return { env: { ...resolveNodeCompileCacheEnv(env) }, cwd: process.cwd() };
}

function createScopedSqliteReadOnlyWorker(
  launch: ReturnType<typeof captureSqliteReadOnlyWorkerLaunch>,
) {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  return createSqliteReadOnlyWorkerSession({
    ...launch,
    argv: [...resolveRuntimeWorkerArgv(workerUrl), SQLITE_READONLY_CHILD_ARG, "session"],
    requestArgs: sqliteReadOnlyWorkerRequestArgs,
    readBudget: (pathname) => readSqliteInspectionBudget("read-only snapshot", pathname),
    deadlineOwnedByCaller: isSqliteInspectionDeadlineOwnedByCaller,
    timeoutError: (pathname, timeoutMs, size) =>
      sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size),
    closeTimeoutMs: SQLITE_INSPECTION_TIMEOUT_MS,
  });
}

export function runSqliteReadOnlyWorker(
  pathname: string,
  options: SqliteAuthProfileReadOptions,
): Promise<SqliteAuthProfileRows>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "sync" | "async"; stagingRoot?: string; signal?: AbortSignal },
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
  options: SqliteReadOnlyWorkerOptions,
): Promise<SqliteReadOnlyWorkerValue> {
  if (options.mode === "reclaim") {
    // Shared reclamation belongs to the allocation owner, not its first caller's scope.
    return readOnlyWorkerScope.exit(() => runSqliteReadOnlyWorkerOnce(pathname, options));
  }
  const scope = readOnlyWorkerScope.getStore();
  if (!scope) {
    return runSqliteReadOnlyWorkerOnce(pathname, options);
  }
  if (!scope.active) {
    return Promise.reject(new Error("SQLite read-only worker scope closed"));
  }
  const scopedOptions = {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, scope.controller.signal])
      : scope.controller.signal,
  };
  // Native backup promises can stall with a persistent IPC handle on Node 26.
  // Keep async backups one-shot; concurrent raw reads need separate processes
  // for POSIX lock isolation.
  // Bun retains native statements after close, so auth reads still need process exit.
  const useScopedWorker =
    (options.mode === "sync" || (options.mode === "auth-profile-rows" && !process.versions.bun)) &&
    !scope.busy;
  const launch = useScopedWorker
    ? captureSqliteReadOnlyWorkerLaunch(
        options.mode === "auth-profile-rows" ? options.env : undefined,
      )
    : undefined;
  if (useScopedWorker) {
    scope.busy = true;
  }
  const operation = (async () => {
    if (!launch) {
      return runSqliteReadOnlyWorkerOnce(pathname, scopedOptions);
    }
    try {
      if (!scope.worker?.compatible(launch)) {
        await scope.worker?.close();
        scopedOptions.signal.throwIfAborted();
        scope.worker = createScopedSqliteReadOnlyWorker(launch);
      }
      return await scope.worker.run(pathname, scopedOptions);
    } finally {
      scope.busy = false;
    }
  })();
  scope.pending.add(operation);
  void operation.then(
    () => scope.pending.delete(operation),
    () => scope.pending.delete(operation),
  );
  return operation;
}

function runSqliteReadOnlyWorkerOnce(
  pathname: string,
  options: SqliteReadOnlyWorkerOptions,
): Promise<SqliteReadOnlyWorkerValue> {
  if (options.mode === "auth-profile-rows") {
    const worker = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch(options.env));
    return (async () => {
      try {
        const value = await worker.run(pathname, options);
        options.signal?.throwIfAborted();
        return value;
      } finally {
        await worker.close();
        options.signal?.throwIfAborted();
      }
    })();
  }
  return new Promise<SqliteReadOnlyWorkerValue>((resolve, reject) => {
    const { timeoutMs, size } = readSqliteInspectionBudget("read-only snapshot", pathname);
    let output: SqliteReadOnlyWorkerOutput = { stderr: "", stdout: "" };
    let stopped = false;
    let reclamationDeadline = false;
    const reclaim = options.mode === "reclaim";
    const child = execFile(
      process.execPath,
      sqliteReadOnlyWorkerArgv(pathname, options),
      {
        encoding: "utf8",
        env: resolveNodeCompileCacheEnv(),
        maxBuffer: SQLITE_READONLY_WORKER_MAX_BUFFER,
        timeout: reclaim || isSqliteInspectionDeadlineOwnedByCaller() ? undefined : timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        output = {
          failure: error
            ? stopped
              ? "snapshot owner stopped"
              : error.killed && error.signal === "SIGKILL" && error.code == null
                ? sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size)
                    .message
                : `exited unsuccessfully: ${error.message}`
            : undefined,
          stderr,
          stdout,
        };
      },
    );
    // execFile does not forward killSignal for AbortSignal cancellation.
    const abort = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (reclaim) {
        child.stdin?.end();
      } else {
        child.kill("SIGKILL");
      }
    };
    // Keep the existing budget, but settle reclamation at a directory boundary.
    const timer = reclaim
      ? setTimeout(() => {
          reclamationDeadline = true;
          abort();
        }, timeoutMs)
      : undefined;
    void retainSnapshotWork(
      new Promise<void>((resolveClosed) => {
        child.once("close", () => resolveClosed());
      }),
      abort,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    // execFile can report an abort/error before close. Ownership ends only
    // after the process and its pipes have closed, including failed launches.
    child.once("close", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try {
        if (options.mode === "reclaim") {
          const warnings = readSqliteReadOnlyWorkerValue(output, "reclaim");
          if (reclamationDeadline) {
            warnings.push(
              sqliteInspectionTimeoutError("reclamation", pathname, timeoutMs, size).message,
            );
          }
          resolve(warnings);
          return;
        }
        options.signal?.throwIfAborted();
        resolve(readSqliteReadOnlyWorkerValue(output, options.mode));
      } catch (workerError) {
        reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
      }
    });
  });
}

export function runSqliteReadOnlyWorkerSync(pathname: string, stagingRoot: string): string {
  const { timeoutMs, size } = readSqliteInspectionBudget("read-only snapshot", pathname);
  const result = spawnSync(
    process.execPath,
    sqliteReadOnlyWorkerArgv(pathname, { mode: "sync", stagingRoot }),
    {
      encoding: "utf8",
      env: resolveNodeCompileCacheEnv(),
      maxBuffer: SQLITE_READONLY_WORKER_MAX_BUFFER,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  const failure = result.error
    ? hasErrnoCode(result.error, "ETIMEDOUT")
      ? sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size).message
      : `failed to start: ${result.error.message}`
    : result.status === 0
      ? undefined
      : `exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`;
  return readSqliteReadOnlyWorkerValue(
    {
      failure,
      stderr: result.stderr,
      stdout: result.stdout,
    },
    "sync",
  );
}
