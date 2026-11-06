import path from "node:path";
import { toUSVString } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PreservedOrphanTaskDelivery } from "../state/openclaw-state-db-task-delivery-recovery-preservation.js";
import type { BackupEngine } from "./database-engine/types.js";
import { markPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import type { SqlitePrivateSnapshotFamily } from "./sqlite-readonly-location.types.js";
import type {
  SqliteReadOnlyOperationCommand,
  SqliteReadOnlyOperationResult,
} from "./sqlite-readonly-operation-types.js";
import { SqliteSnapshotCapacityError } from "./sqlite-snapshot-capacity-error.js";
import type { SqliteSnapshotReclamation } from "./sqlite-snapshot-reclamation.js";
import { readDatabaseFileIdentity, type DatabaseFileIdentity } from "./sqlite-worker-identity.js";

// Keep the one-shot execFile output limit when inspections use IPC.
export const SQLITE_READONLY_WORKER_MAX_BUFFER = 1024 * 1024;

export type SqliteReadOnlyWorkerMode =
  | "sync"
  | "backup-engine"
  | "private-fork"
  | "content-version"
  | "file-generation"
  | "update-generation"
  | "async"
  | "staged-sync"
  | "staged-async"
  | "metadata"
  | "consolidated"
  | "task-delivery-recovery"
  | "auth-profile-rows"
  | "operation"
  | "staging-create"
  | "staging-create-legacy"
  | "staging-reconcile"
  | "staging-sweep"
  | "staging-retire";
export function isSqliteSnapshotStagingMode(mode: unknown): boolean {
  return (
    mode === "staging-create" ||
    mode === "staging-create-legacy" ||
    mode === "staging-reconcile" ||
    mode === "staging-sweep" ||
    mode === "staging-retire"
  );
}

export type SqliteReadOnlyWorkerResult =
  | { ok: true; engine: BackupEngine }
  | { ok: true; reclamation: SqliteSnapshotReclamation }
  | { ok: true; location: string }
  | { ok: true; contentVersion: string }
  | { ok: true; generation: string }
  | { ok: true; taskDeliveryRecovery: PreservedOrphanTaskDelivery }
  | { ok: false; message: string };

export class SqliteReadOnlyInspectionContentionError extends Error {}

// Released updater parents require exactly { ok, message }. A negotiated worker
// protocol can replace this owner-generated tag when those parents are retired.
export const SQLITE_INSPECTION_CONTENTION_PREFIX = "Retryable SQLite inspection contention: ";
export const SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX =
  "SQLite snapshot directory creation refused: ";
export const SQLITE_SNAPSHOT_CAPACITY_PREFIX = "SQLite snapshot capacity unavailable: ";

export type SqliteAuthProfileRows = { store: unknown; state: unknown; cacheable: boolean };
export type SqliteAuthProfileReadOptions = {
  mode: "auth-profile-rows";
  source: "canonical" | "snapshot";
  expectedIdentity: string;
  artifactPreserving?: true;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stagingRoot?: never;
};
export type SqliteReadOnlyOperationOptions = Omit<SqliteAuthProfileReadOptions, "mode"> & {
  mode: "operation";
  command: SqliteReadOnlyOperationCommand;
};
export type SqliteReadOnlyWorkerOptions =
  | SqliteAuthProfileReadOptions
  | SqliteReadOnlyOperationOptions
  | {
      mode: "task-delivery-recovery";
      recoveryDirectory: string;
      sourcePath: string;
      signal?: AbortSignal;
      stagingRoot?: never;
      expectedSourceIdentity?: never;
    }
  | {
      mode: "private-fork";
      family: SqlitePrivateSnapshotFamily;
      stagingRoot: string;
      signal?: AbortSignal;
    }
  | {
      mode: "staged-sync" | "staged-async";
      stagingRoot: string;
      signal?: AbortSignal;
      expectedSourceIdentity?: DatabaseFileIdentity;
    }
  | {
      mode: Exclude<
        SqliteReadOnlyWorkerMode,
        | "auth-profile-rows"
        | "operation"
        | "private-fork"
        | "staged-sync"
        | "staged-async"
        | "task-delivery-recovery"
      >;
      stagingRoot?: string;
      signal?: AbortSignal;
      expectedSourceIdentity?: DatabaseFileIdentity;
    };
export function sqliteReadOnlyWorkerRequestArgs(
  pathname: string,
  options: SqliteReadOnlyWorkerOptions,
): string[] {
  const args = [options.mode, path.resolve(pathname)];
  if (options.mode === "task-delivery-recovery") {
    return [...args, path.resolve(options.recoveryDirectory), path.resolve(options.sourcePath)];
  }
  const stagingRoot = options.stagingRoot && path.resolve(options.stagingRoot);
  if (options.mode === "private-fork") {
    return [...args, stagingRoot ?? "", JSON.stringify(options.family)];
  }
  const expected =
    options.mode === "auth-profile-rows" || options.mode === "operation"
      ? undefined
      : options.expectedSourceIdentity;
  if (expected !== undefined) {
    if (options.mode !== "sync" && options.mode !== "staged-sync" && options.mode !== "metadata") {
      throw new Error("SQLite source identity is supported only for sync or metadata snapshots");
    }
    args.push(stagingRoot ?? "", JSON.stringify(readDatabaseFileIdentity(expected)));
  } else if (stagingRoot) {
    args.push(stagingRoot);
  }
  return args;
}

export type SqliteReadOnlyWorkerOutput =
  | {
      kind: "launched";
      stdout: string;
      stderr: string;
      status: number | null;
      failure?: string;
      cause?: Error;
    }
  | { kind: "launch-failed"; error: Error };
export type SqliteReadOnlyWorkerValue =
  | BackupEngine
  | SqliteSnapshotReclamation
  | string
  | SqliteAuthProfileRows
  | PreservedOrphanTaskDelivery
  | SqliteReadOnlyOperationResult;
export const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;

export function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  return (
    (value.ok === true &&
      "engine" in value &&
      isRecord(value.engine) &&
      (value.engine.engine === "sqlite" ||
        (value.engine.engine === "postgres" &&
          typeof value.engine.storeId === "string" &&
          typeof value.engine.namespace === "string"))) ||
    (value.ok === true &&
      "reclamation" in value &&
      isRecord(value.reclamation) &&
      [value.reclamation.removed, value.reclamation.bytes, value.reclamation.skipped].every(
        (count) => typeof count === "number" && Number.isFinite(count) && count >= 0,
      )) ||
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === true &&
      "contentVersion" in value &&
      typeof value.contentVersion === "string" &&
      /^(?:[a-f0-9]{64})?$/.test(value.contentVersion)) ||
    (value.ok === true && "generation" in value && typeof value.generation === "string") ||
    (value.ok === true &&
      "taskDeliveryRecovery" in value &&
      isRecord(value.taskDeliveryRecovery) &&
      Object.keys(value.taskDeliveryRecovery).length === 2 &&
      typeof value.taskDeliveryRecovery.count === "number" &&
      Number.isSafeInteger(value.taskDeliveryRecovery.count) &&
      value.taskDeliveryRecovery.count > 0 &&
      typeof value.taskDeliveryRecovery.payloadSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.taskDeliveryRecovery.payloadSha256)) ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

export function createSqliteReadOnlyWorkerError(
  message: string,
  stderr: string,
  options?: ErrorOptions,
): Error {
  // Node can split a decoded surrogate pair when its child stderr buffer overflows.
  const stderrTail = toUSVString(sliceUtf16Safe(stderr.trim(), -SQLITE_READONLY_STDERR_TAIL_CHARS));
  return new Error(
    `SQLite read-only worker ${message}${stderrTail ? `\nstderr (tail): ${stderrTail}` : ""}`,
    options,
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
  mode: "backup-engine",
): BackupEngine;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "task-delivery-recovery",
): PreservedOrphanTaskDelivery;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode:
    | "sync"
    | "private-fork"
    | "async"
    | "staged-sync"
    | "staged-async"
    | "metadata"
    | "consolidated"
    | "content-version"
    | "file-generation"
    | "update-generation",
): string;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): SqliteReadOnlyWorkerValue;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): SqliteReadOnlyWorkerValue {
  if (params.kind === "launch-failed") {
    throw params.error;
  }
  let result: SqliteReadOnlyWorkerResult;
  try {
    result = parseSqliteReadOnlyWorkerResult(params.stdout, params.stderr);
  } catch (error) {
    if (params.failure) {
      throw createSqliteReadOnlyWorkerError(params.failure, params.stderr, { cause: params.cause });
    }
    throw error;
  }
  if (params.status !== 0 || params.failure || !result.ok) {
    const capacity =
      !result.ok &&
      (params.status === 0 || params.status === 1) &&
      result.message.startsWith(SQLITE_SNAPSHOT_CAPACITY_PREFIX);
    const failureMessage = !result.ok
      ? capacity
        ? result.message.slice(SQLITE_SNAPSHOT_CAPACITY_PREFIX.length)
        : result.message
      : (params.failure ?? `exited with code ${params.status}`);
    const contention = !result.ok && failureMessage.startsWith(SQLITE_INSPECTION_CONTENTION_PREFIX);
    const message = contention
      ? failureMessage.slice(SQLITE_INSPECTION_CONTENTION_PREFIX.length)
      : failureMessage;
    const allocationRefused =
      params.failure === undefined &&
      !result.ok &&
      (mode === "staging-create" || mode === "staging-create-legacy") &&
      message.startsWith(SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX);
    const error = createSqliteReadOnlyWorkerError(
      allocationRefused ? message.slice(SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX.length) : message,
      params.stderr,
      { cause: params.cause },
    );
    if (capacity) {
      throw new SqliteSnapshotCapacityError(error.message, { cause: params.cause });
    }
    if (contention) {
      const failure = new SqliteReadOnlyInspectionContentionError(error.message);
      throw allocationRefused ? markPrivateDirectoryCreationRefused(failure) : failure;
    }
    throw error;
  }
  if (
    (mode === "sync" ||
      mode === "private-fork" ||
      mode === "async" ||
      mode === "staged-sync" ||
      mode === "staged-async" ||
      mode === "metadata" ||
      mode === "consolidated" ||
      isSqliteSnapshotStagingMode(mode)) &&
    "location" in result
  ) {
    return result.location;
  }
  if (mode === "staging-sweep" && "reclamation" in result) {
    return result.reclamation;
  }
  if (mode === "backup-engine" && "engine" in result) {
    return result.engine;
  }
  if (mode === "content-version" && "contentVersion" in result) {
    return result.contentVersion;
  }
  if ((mode === "file-generation" || mode === "update-generation") && "generation" in result) {
    return result.generation;
  }
  if (mode === "task-delivery-recovery" && "taskDeliveryRecovery" in result) {
    return result.taskDeliveryRecovery;
  }
  throw createSqliteReadOnlyWorkerError(
    "returned a result for a different operation",
    params.stderr,
  );
}
