import { toUSVString } from "node:util";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Keep the one-shot execFile output limit when inspections use IPC.
export const SQLITE_READONLY_WORKER_MAX_BUFFER = 1024 * 1024;

export type SqliteReadOnlyWorkerMode =
  | "sync"
  | "content-version"
  | "async"
  | "consolidated"
  | "reclaim"
  | "auth-profile-rows"
  | "staging-create"
  | "staging-create-legacy"
  | "staging-reconcile"
  | "staging-retire";
export function isSqliteSnapshotStagingMode(mode: unknown): boolean {
  return (
    mode === "staging-create" ||
    mode === "staging-create-legacy" ||
    mode === "staging-reconcile" ||
    mode === "staging-retire"
  );
}

export type SqliteReadOnlyWorkerResult =
  | { ok: true; location: string }
  | { ok: true; contentVersion: string }
  | { ok: true; warnings: string[] }
  | { ok: false; message: string };

export class SqliteReadOnlyInspectionContentionError extends Error {}

// Released updater parents require exactly { ok, message }. A negotiated worker
// protocol can replace this owner-generated tag when those parents are retired.
export const SQLITE_INSPECTION_CONTENTION_PREFIX = "Retryable SQLite inspection contention: ";

export type SqliteAuthProfileRows = { store: unknown; state: unknown; cacheable: boolean };
export type SqliteAuthProfileReadOptions = {
  mode: "auth-profile-rows";
  source: "canonical" | "snapshot";
  expectedIdentity: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stagingRoot?: never;
};
export type SqliteReadOnlyWorkerOptions =
  | SqliteAuthProfileReadOptions
  | {
      mode: Exclude<SqliteReadOnlyWorkerMode, "auth-profile-rows">;
      stagingRoot?: string;
      signal?: AbortSignal;
    };
export type SqliteReadOnlyWorkerOutput = { failure?: string; stderr: string; stdout: string };
export type SqliteReadOnlyWorkerValue = string | string[] | SqliteAuthProfileRows;
export const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;

export function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  return (
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === true &&
      "contentVersion" in value &&
      typeof value.contentVersion === "string" &&
      /^(?:[a-f0-9]{64})?$/.test(value.contentVersion)) ||
    (value.ok === true &&
      "warnings" in value &&
      Array.isArray(value.warnings) &&
      value.warnings.every((warning) => typeof warning === "string")) ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

export function createSqliteReadOnlyWorkerError(message: string, stderr: string): Error {
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

export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "sync" | "async" | "consolidated" | "content-version",
): string;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "reclaim",
): string[];
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): SqliteReadOnlyWorkerValue;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): SqliteReadOnlyWorkerValue {
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
    const contention = !result.ok && result.message.startsWith(SQLITE_INSPECTION_CONTENTION_PREFIX);
    const error = createSqliteReadOnlyWorkerError(
      !result.ok
        ? contention
          ? result.message.slice(SQLITE_INSPECTION_CONTENTION_PREFIX.length)
          : result.message
        : (params.failure ?? "failed"),
      params.stderr,
    );
    if (contention) {
      throw new SqliteReadOnlyInspectionContentionError(error.message);
    }
    throw error;
  }
  if (
    (mode === "sync" ||
      mode === "async" ||
      mode === "consolidated" ||
      isSqliteSnapshotStagingMode(mode)) &&
    "location" in result
  ) {
    return result.location;
  }
  if (mode === "content-version" && "contentVersion" in result) {
    return result.contentVersion;
  }
  if (mode === "reclaim" && "warnings" in result) {
    return result.warnings;
  }
  throw createSqliteReadOnlyWorkerError(
    "returned a result for a different operation",
    params.stderr,
  );
}
