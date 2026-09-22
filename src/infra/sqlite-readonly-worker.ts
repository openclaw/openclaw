import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { getCompileCacheDir } from "node:module";
import path from "node:path";
import { toUSVString } from "node:util";
import { formatByteSize } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errno.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerMode,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";
import type { SqliteSchemaHeader } from "./sqlite-schema-header.js";

const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;
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

type SqliteReadOnlyWorkerOutput = { failure?: string; stderr: string; stdout: string };
type SqliteReadOnlyWorkerOptions = {
  mode: SqliteReadOnlyWorkerMode;
  stagingRoot?: string;
  signal?: AbortSignal;
  agentSchemaVersionForOwnership?: number;
};

type SqliteReadOnlyWorkerScope = {
  active: boolean;
  busy: boolean;
  controller: AbortController;
  pending: Set<Promise<string | SqliteSchemaHeader>>;
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

function isAgentSchemaMeta(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 3 &&
      "agentId" in value &&
      (value.agentId === null || typeof value.agentId === "string") &&
      "role" in value &&
      (value.role === null || typeof value.role === "string") &&
      "schemaVersion" in value &&
      (value.schemaVersion === null || typeof value.schemaVersion === "number"))
  );
}

function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  if (value.ok === true && "header" in value) {
    const header = value.header;
    return (
      header !== null &&
      typeof header === "object" &&
      "userVersion" in header &&
      typeof header.userVersion === "number" &&
      Number.isInteger(header.userVersion) &&
      Object.keys(header).every(
        (key) => key === "userVersion" || key === "writerAppVersion" || key === "agentSchemaMeta",
      ) &&
      (!("writerAppVersion" in header) || typeof header.writerAppVersion === "string") &&
      (!("agentSchemaMeta" in header) || isAgentSchemaMeta(header.agentSchemaMeta))
    );
  }
  return (
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

function createSqliteReadOnlyWorkerError(message: string, stderr: string): Error {
  // Node can split a decoded surrogate pair when its child stderr buffer overflows.
  const stderrTail = toUSVString(sliceUtf16Safe(stderr.trim(), -SQLITE_READONLY_STDERR_TAIL_CHARS));
  return new Error(
    `SQLite read-only worker ${message}${stderrTail ? `\nstderr (tail): ${stderrTail}` : ""}`,
  );
}

function parseSqliteReadOnlyWorkerResult(
  stdout: string,
  stderr: string,
): SqliteReadOnlyWorkerResult {
  if (!stdout.trim()) {
    throw createSqliteReadOnlyWorkerError("returned no JSON result", stderr);
  }
  let message: unknown;
  try {
    message = JSON.parse(stdout);
  } catch {
    throw createSqliteReadOnlyWorkerError("returned invalid JSON", stderr);
  }
  if (!isSqliteReadOnlyWorkerResult(message)) {
    throw createSqliteReadOnlyWorkerError("returned an invalid result", stderr);
  }
  return message;
}

function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "schema-header",
): SqliteSchemaHeader;
function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "sync" | "async",
): string;
function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): string | SqliteSchemaHeader;
function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): string | SqliteSchemaHeader {
  let result: SqliteReadOnlyWorkerResult;
  try {
    result = parseSqliteReadOnlyWorkerResult(params.stdout, params.stderr);
  } catch (error) {
    if (params.failure) {
      throw createSqliteReadOnlyWorkerError(params.failure, params.stderr);
    }
    throw error;
  }
  if (params.failure || !result.ok) {
    throw createSqliteReadOnlyWorkerError(
      !result.ok ? result.message : (params.failure ?? "failed"),
      params.stderr,
    );
  }
  if (mode === "schema-header" && "header" in result) {
    return result.header;
  }
  if (mode !== "schema-header" && "location" in result) {
    return result.location;
  }
  throw createSqliteReadOnlyWorkerError(
    "returned a result for a different operation",
    params.stderr,
  );
}

function sqliteReadOnlyWorkerRequestArgs(pathname: string, options: SqliteReadOnlyWorkerOptions) {
  return [
    options.mode,
    path.resolve(pathname),
    ...(options.stagingRoot || options.agentSchemaVersionForOwnership !== undefined
      ? [options.stagingRoot ?? ""]
      : []),
    ...(options.agentSchemaVersionForOwnership !== undefined
      ? [String(options.agentSchemaVersionForOwnership)]
      : []),
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

function sqliteReadOnlyWorkerEnv(): NodeJS.ProcessEnv {
  const env = process.env;
  if (env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return env;
  }
  // Programmatic cache enablement applies only to the current Node instance.
  const directory = getCompileCacheDir?.();
  return directory ? { ...env, NODE_COMPILE_CACHE: directory } : env;
}

function createScopedSqliteReadOnlyWorker() {
  const env = { ...sqliteReadOnlyWorkerEnv() };
  const cwd = process.cwd();
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  const child = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(workerUrl), SQLITE_READONLY_CHILD_ARG, "session"],
    { env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let retired = false;
  let sequence = 0;
  let stderr = "";
  let outputBytes = 0;
  let pending:
    | {
        id: number;
        mode: SqliteReadOnlyWorkerMode;
        resolve: (value: string | SqliteSchemaHeader) => void;
        reject: (error: unknown) => void;
        cleanup: () => void;
        failure?: unknown;
      }
    | undefined;
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const retire = (error?: unknown) => {
    retired = true;
    if (pending && error !== undefined) {
      pending.failure ??= error;
    }
    child.kill("SIGKILL");
  };
  child.on("error", (error) => retire(error));
  child.once("close", (code, signal) => {
    retired = true;
    if (pending) {
      const request = pending;
      pending = undefined;
      request.cleanup();
      request.reject(
        request.failure ??
          createSqliteReadOnlyWorkerError(
            `exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
            stderr,
          ),
      );
    }
    resolveClosed();
  });
  const captureOutput = (data: Buffer, isStderr: boolean) => {
    outputBytes += data.length;
    if (isStderr) {
      stderr = sliceUtf16Safe(stderr + data.toString("utf8"), -SQLITE_READONLY_STDERR_TAIL_CHARS);
    }
    if (outputBytes > SQLITE_READONLY_WORKER_MAX_BUFFER) {
      retire(createSqliteReadOnlyWorkerError("exceeded its output buffer", stderr));
    }
  };
  child.stdout?.on("data", (data: Buffer) => captureOutput(data, false));
  child.stderr?.on("data", (data: Buffer) => captureOutput(data, true));
  child.on("message", (message: unknown) => {
    if (retired) {
      return;
    }
    if (
      !pending ||
      !message ||
      typeof message !== "object" ||
      Object.keys(message).length !== 2 ||
      !("id" in message) ||
      message.id !== pending.id ||
      !("result" in message)
    ) {
      retire(createSqliteReadOnlyWorkerError("returned an unexpected response", stderr));
      return;
    }
    try {
      const value = readSqliteReadOnlyWorkerValue(
        { stdout: JSON.stringify(message.result), stderr },
        pending.mode,
      );
      const request = pending;
      pending = undefined;
      request.cleanup();
      request.resolve(value);
    } catch (error) {
      // A failed native close can retain a source lease. Do not reject the
      // request (and let its staging directory disappear) until process close.
      retire(error);
    }
  });
  return {
    compatible() {
      const currentEnv = sqliteReadOnlyWorkerEnv();
      const keys = Object.keys(currentEnv);
      return (
        !retired &&
        process.cwd() === cwd &&
        keys.length === Object.keys(env).length &&
        keys.every((key) => currentEnv[key] === env[key])
      );
    },
    run(pathname: string, options: SqliteReadOnlyWorkerOptions) {
      return new Promise<string | SqliteSchemaHeader>((resolve, reject) => {
        const { timeoutMs, size } = readSqliteInspectionBudget("read-only snapshot", pathname);
        stderr = "";
        outputBytes = 0;
        const abort = () => retire(options.signal?.reason);
        const timer = isSqliteInspectionDeadlineOwnedByCaller()
          ? undefined
          : setTimeout(
              () =>
                retire(
                  sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size),
                ),
              timeoutMs,
            );
        const id = ++sequence;
        pending = {
          id,
          mode: options.mode,
          resolve,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
          },
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) {
          abort();
          return;
        }
        try {
          child.send(
            {
              id,
              args: sqliteReadOnlyWorkerRequestArgs(pathname, options),
            },
            (error) => {
              if (error) {
                retire(error);
              }
            },
          );
        } catch (error) {
          retire(error);
        }
      });
    },
    async close() {
      if (retired) {
        await closed;
        return;
      }
      retired = true;
      // An idle child may flush Node's compile cache before exiting. Retain the
      // inspection budget as a ceiling if shutdown does not finish normally.
      const timer = setTimeout(() => retire(), SQLITE_INSPECTION_TIMEOUT_MS);
      try {
        // Child-owned disconnect preserves Node's process-and-pipes close event.
        child.send("close", (error) => {
          if (error) {
            retire(error);
          }
        });
      } catch (error) {
        retire(error);
      }
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function runSqliteReadOnlyWorker(
  pathname: string,
  options: {
    mode: "schema-header";
    stagingRoot?: string;
    signal?: AbortSignal;
    agentSchemaVersionForOwnership?: number;
  },
): Promise<SqliteSchemaHeader>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "sync" | "async"; stagingRoot?: string; signal?: AbortSignal },
): Promise<string>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: SqliteReadOnlyWorkerOptions,
): Promise<string | SqliteSchemaHeader> {
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
  // Header inspection may also need a backup during recovery. Keep both modes
  // one-shot; concurrent raw reads need separate processes for POSIX lock isolation.
  const useScopedWorker = options.mode === "sync" && !scope.busy;
  if (useScopedWorker) {
    scope.busy = true;
  }
  const operation = (async () => {
    if (!useScopedWorker) {
      return runSqliteReadOnlyWorkerOnce(pathname, scopedOptions);
    }
    try {
      if (!scope.worker?.compatible()) {
        await scope.worker?.close();
        scopedOptions.signal.throwIfAborted();
        scope.worker = createScopedSqliteReadOnlyWorker();
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
): Promise<string | SqliteSchemaHeader> {
  return new Promise<string | SqliteSchemaHeader>((resolve, reject) => {
    const { timeoutMs, size } = readSqliteInspectionBudget("read-only snapshot", pathname);
    let output: SqliteReadOnlyWorkerOutput = { stderr: "", stdout: "" };
    const child = execFile(
      process.execPath,
      sqliteReadOnlyWorkerArgv(pathname, options),
      {
        encoding: "utf8",
        env: sqliteReadOnlyWorkerEnv(),
        maxBuffer: SQLITE_READONLY_WORKER_MAX_BUFFER,
        timeout: isSqliteInspectionDeadlineOwnedByCaller() ? undefined : timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        output = {
          failure: error
            ? error.killed && error.signal === "SIGKILL" && error.code == null
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
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    // execFile can report an abort/error before close. Ownership ends only
    // after the process and its pipes have closed, including failed launches.
    child.once("close", () => {
      options.signal?.removeEventListener("abort", abort);
      try {
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
      env: sqliteReadOnlyWorkerEnv(),
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
