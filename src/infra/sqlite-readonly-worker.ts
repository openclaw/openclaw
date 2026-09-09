import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toUSVString } from "node:util";
import { formatByteSize } from "@openclaw/normalization-core";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errno.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";
const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;
const SQLITE_INSPECTION_TIMEOUT_MS = 30_000;
const SQLITE_INSPECTION_TIMEOUT_MAX_MS = 30 * 60_000;
const log = createSubsystemLogger("state/sqlite");

export function resolveSqliteInspectionBudget(
  operation: string,
  pathname: string,
  sizeBytes: number | bigint | undefined,
): { timeoutMs: number; size: string } {
  // A full copy or integrity scan reads the whole file at least once.
  // 32 MiB/s is a conservative cold-cache floor on cloud block storage; the
  // fixed 30 seconds covers child startup and shutdown.
  const timeoutMs = Math.min(
    SQLITE_INSPECTION_TIMEOUT_MS + Math.ceil(Number(sizeBytes ?? 0) / (32 * 1024 * 1024)) * 1000,
    SQLITE_INSPECTION_TIMEOUT_MAX_MS,
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

function readSqliteSnapshotBudget(pathname: string): { timeoutMs: number; size: string } {
  let sizeBytes: bigint | undefined;
  try {
    sizeBytes = fs.statSync(pathname, { bigint: true }).size;
  } catch {
    // Let the child report the source error with its normal diagnostics.
  }
  return resolveSqliteInspectionBudget("read-only snapshot", pathname, sizeBytes);
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

type SqliteReadOnlyWorkerResult = { ok: true; location: string } | { ok: false; message: string };
type SqliteReadOnlyWorkerOutput = { failure?: string; stderr: string; stdout: string };

function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
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

function readSqliteReadOnlyWorkerLocation(params: SqliteReadOnlyWorkerOutput): string {
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
  return result.location;
}

function sqliteReadOnlyWorkerArgv(pathname: string, mode: "sync" | "async", stagingRoot?: string) {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  return [
    ...resolveRuntimeWorkerArgv(workerUrl),
    SQLITE_READONLY_CHILD_ARG,
    mode,
    path.resolve(pathname),
    ...(stagingRoot ? [stagingRoot] : []),
  ];
}

export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "sync" | "async"; stagingRoot?: string; signal?: AbortSignal },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { timeoutMs, size } = readSqliteSnapshotBudget(pathname);
    let output: SqliteReadOnlyWorkerOutput = { stderr: "", stdout: "" };
    const child = execFile(
      process.execPath,
      sqliteReadOnlyWorkerArgv(pathname, options.mode, options.stagingRoot),
      {
        encoding: "utf8",
        timeout: timeoutMs,
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
        resolve(readSqliteReadOnlyWorkerLocation(output));
      } catch (workerError) {
        reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
      }
    });
  });
}

export function runSqliteReadOnlyWorkerSync(pathname: string, stagingRoot: string): string {
  const { timeoutMs, size } = readSqliteSnapshotBudget(pathname);
  const result = spawnSync(
    process.execPath,
    sqliteReadOnlyWorkerArgv(pathname, "sync", stagingRoot),
    {
      encoding: "utf8",
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
  return readSqliteReadOnlyWorkerLocation({
    failure,
    stderr: result.stderr,
    stdout: result.stdout,
  });
}
