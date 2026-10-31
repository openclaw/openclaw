import { AsyncLocalStorage } from "node:async_hooks";
import {
  coerceErrorMessage,
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { POSTGRES_QUERY_CANCELED_ERROR_NAME } from "./postgres-sync/protocol.js";
import {
  hasSqliteWorkerErrorCode,
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
} from "./sqlite-worker-error.js";

const STORAGE_ERRORS = [
  ["SQLITE_BUSY", "database is locked", 5],
  ["SQLITE_LOCKED", "database table is locked", 6],
  ["SQLITE_READONLY", "attempt to write a readonly database", 8],
  ["SQLITE_IOERR", "disk I/O error", 10],
  ["SQLITE_IOERR", "unable to open database file", 14],
  ["SQLITE_FULL", "database or disk is full", 13],
  ["transcript_writer_fenced", "session writer claim changed before transcript persistence", -1],
  [
    "session_actor_reconciliation",
    "Session actor requires reconciliation before another command",
    -2,
  ],
] as const;
export type GatewayStorageFailure = (typeof STORAGE_ERRORS)[number][0] | "57014" | "unavailable";

function readOwnErrorDataProperty(value: object, key: string): unknown {
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

/** Retired admission cannot recover by replaying a channel, model, or state operation. */
export function isStateDatabaseAdmissionClosedError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some((candidate) => {
    const fields =
      typeof candidate === "string" ? { message: candidate } : isRecord(candidate) ? candidate : {};
    const code =
      readOwnErrorDataProperty(fields, "errorCode") ?? readOwnErrorDataProperty(fields, "code");
    const message =
      readOwnErrorDataProperty(fields, "errorMessage") ??
      readOwnErrorDataProperty(fields, "message");
    return (
      code === "STATE_DATABASE_READ_ADMISSION_INVALIDATED" ||
      (typeof message === "string" && message.includes("Shared-state worker is retiring"))
    );
  });
}

/** These outcomes must leave tool execution without becoming model-visible tool errors. */
export function isLocalStorageOutcomeError(error: unknown): boolean {
  // Presentation can select a primary failure, but every uncertain write still fences continuation.
  if (hasSqliteWorkerOutcomeUnknown(error)) {
    return true;
  }
  try {
    if (isStateDatabaseAdmissionClosedError(error)) {
      return true;
    }
    const failure = classifyGatewayStorageFailure(error);
    return failure === "session_actor_reconciliation" || failure === "57014";
  } catch {
    // Optional diagnostics must not replace an ordinary tool failure.
    return false;
  }
}

/** Classify native errors before flattening; legacy rows require exact known messages. */
export function classifyGatewayStorageFailure(error: unknown): GatewayStorageFailure | undefined {
  let primaryError = error;
  let outcomeUnknown = false;
  let unavailable: GatewayStorageFailure | undefined;
  const seen = new Set<unknown>();
  // Cleanup envelopes explicitly identify the operation's primary failure.
  // Secondary cleanup diagnostics must not replace its user-facing outcome.
  for (let current = error; current instanceof Error && !seen.has(current);) {
    seen.add(current);
    outcomeUnknown ||= hasSqliteWorkerErrorCode(current, "outcome-unknown");
    if (isSqliteWorkerError(current, "unavailable")) {
      unavailable = "unavailable";
    }
    const cause = readOwnErrorDataProperty(current, "cause");
    if (current instanceof AggregateError) {
      const errors = readOwnErrorDataProperty(current, "errors");
      if (
        !(cause instanceof Error) ||
        !Array.isArray(errors) ||
        readOwnErrorDataProperty(errors, "0") !== cause
      ) {
        break;
      }
      primaryError = cause;
    }
    current = cause;
  }
  if (outcomeUnknown || hasSqliteWorkerOutcomeUnknown(primaryError)) {
    return "session_actor_reconciliation";
  }
  let cancellation: GatewayStorageFailure | undefined;
  let reconciliation: GatewayStorageFailure | undefined;
  for (const candidate of collectNestedErrorCandidates(primaryError)) {
    const failure = classifyStorageFailure(candidate);
    if (failure === "session_actor_reconciliation") {
      reconciliation = failure;
    } else if (failure === "57014") {
      cancellation = failure;
    } else if (failure === "unavailable") {
      unavailable = failure;
    } else if (failure) {
      return failure;
    }
  }
  // Native storage diagnostics can refine the guidance without promoting a known rollback.
  return (
    unavailable ??
    reconciliation ??
    cancellation ??
    (hasSqliteWorkerOutcomeUnknown(error) ? "session_actor_reconciliation" : undefined)
  );
}

function classifyStorageFailure(error: unknown): GatewayStorageFailure | undefined {
  if (isSqliteWorkerError(error, "unavailable")) {
    return "unavailable";
  }
  const fields = typeof error === "string" ? { message: error } : isRecord(error) ? error : {};
  const code =
    readOwnErrorDataProperty(fields, "errorCode") ?? readOwnErrorDataProperty(fields, "code");
  // Only the host projection's typed pair carries confirmed rollback presentation.
  if (
    code === "unavailable" &&
    readOwnErrorDataProperty(fields, "errorType") === "SqliteWorkerError"
  ) {
    return "unavailable";
  }
  // The decoder's name survives the actor's name/message-only error projection.
  // A provider's unrelated 57014 code must not acquire storage semantics.
  if (
    readOwnErrorDataProperty(fields, "errorType") === POSTGRES_QUERY_CANCELED_ERROR_NAME ||
    readOwnErrorDataProperty(fields, "name") === POSTGRES_QUERY_CANCELED_ERROR_NAME
  ) {
    return "57014";
  }
  if (code === "ENOSPC") {
    return "SQLITE_FULL";
  }
  if (code === "EIO") {
    return "SQLITE_IOERR";
  }
  if (
    typeof code === "string" &&
    (code === "SQLITE_CANTOPEN" || code.startsWith("SQLITE_CANTOPEN_"))
  ) {
    return "SQLITE_IOERR";
  }
  const nativeCode = readOwnErrorDataProperty(fields, "errcode");
  const primaryCode =
    typeof nativeCode === "number" && Number.isInteger(nativeCode) && nativeCode >= 0
      ? nativeCode & 0xff
      : undefined;
  const typed = STORAGE_ERRORS.find(
    ([name, , number]) =>
      primaryCode === number ||
      (typeof code === "string" &&
        (code === name || (name.startsWith("SQLITE_") && code.startsWith(`${name}_`)))),
  );
  return (typed ??
    STORAGE_ERRORS.find(([, message]) =>
      [
        readOwnErrorDataProperty(fields, "errstr"),
        readOwnErrorDataProperty(fields, "errorMessage"),
        readOwnErrorDataProperty(fields, "message"),
      ].some((value) => typeof value === "string" && value.trim() === message),
    ))?.[0];
}

const SQLITE_INSPECTION_OPERATIONS = {
  source: "opening the source database",
  snapshot: "creating its private snapshot",
} as const;
type SqliteInspectionOperation = keyof typeof SQLITE_INSPECTION_OPERATIONS;

const inspectionOperations = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteInspectionOperations"),
  () => new WeakMap<object, SqliteInspectionOperation>(),
);

const nativeOpenFailures = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteNativeOpenFailures"),
  () => new WeakSet<object>(),
);

type SqliteSnapshotFailureScope = { failure?: { error: unknown } };
const snapshotFailureScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSnapshotFailureScopes"),
  () => new AsyncLocalStorage<SqliteSnapshotFailureScope>(),
);

/** A failed native request stays an inspection failure if an optional consumer catches it. */
export async function withSqliteSnapshotFailureScope<T>(operation: () => Promise<T>): Promise<T> {
  if (snapshotFailureScopes.getStore()) {
    return operation();
  }
  const scope: SqliteSnapshotFailureScope = {};
  const result = await snapshotFailureScopes.run(scope, operation);
  if (scope.failure) {
    throw scope.failure.error;
  }
  return result;
}

/** Call after request cleanup settles, with the final error and its native cause intact. */
export function recordSqliteSnapshotFailure(error: unknown): void {
  const scope = snapshotFailureScopes.getStore();
  if (scope) {
    scope.failure ??= { error };
  }
}

export function markSqliteNativeOpenFailure(error: unknown): void {
  if (error !== null && typeof error === "object") {
    nativeOpenFailures.add(error);
  }
}

/** Record the native effect without changing its error or tagging surrounding authority checks. */
export function withSqliteNativeOpen<T>(open: () => T): T {
  try {
    return open();
  } catch (error) {
    markSqliteNativeOpenFailure(error);
    throw error;
  }
}

export function isSqliteNativeOpenFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && nativeOpenFailures.has(error);
}

export function markSqliteInspectionOperation(
  error: unknown,
  operation: SqliteInspectionOperation,
): unknown {
  if (error !== null && typeof error === "object" && !inspectionOperations.has(error)) {
    inspectionOperations.set(error, operation);
  }
  return error;
}

export function withSqliteInspectionOperation<T>(
  operation: SqliteInspectionOperation,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    throw markSqliteInspectionOperation(error, operation);
  }
}

export function formatSqliteReadOnlyInspectionFailure(error: unknown): string {
  const message = coerceErrorMessage(error);
  const { suffix, operation } = readSqliteErrorDetails(error);
  const details = `${message}${suffix}`;
  return operation === undefined
    ? details
    : `failed while ${SQLITE_INSPECTION_OPERATIONS[operation]}: ${details}`;
}

export function formatSqliteErrorCodeSuffix(error: unknown): string {
  return readSqliteErrorDetails(error).suffix;
}

function readSqliteErrorDetails(error: unknown) {
  const details = new Set<string>();
  let operation: SqliteInspectionOperation | undefined;
  // Preserve native codes through wrappers without exposing cause prose or metadata.
  // The depth cap also bounds cyclic causes; Node's SQLite errcode is a signed int.
  for (let current = error, depth = 0; depth < 8 && isRecord(current); depth += 1) {
    operation = inspectionOperations.get(current) ?? operation;
    const code = extractErrorCode(current);
    if (code && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      details.add(`code=${code}`);
    }
    const { errcode } = current;
    if (
      typeof errcode === "number" &&
      Number.isInteger(errcode) &&
      errcode >= 0 &&
      errcode <= 0x7fff_ffff
    ) {
      details.add(`errcode=${errcode}`);
    }
    current = current.cause;
  }
  return { suffix: details.size > 0 ? ` (${[...details].join(", ")})` : "", operation };
}

// Native snapshot coordination needs classification without loading transaction logging.
const SQLITE_LOCK_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
// Node reports SQLite failures with a generic string code and the extended
// SQLite result in `errcode`; the low byte identifies BUSY or LOCKED.
const SQLITE_BUSY_RESULT_CODE = 5;
const SQLITE_LOCKED_RESULT_CODE = 6;
const SQLITE_CORRUPT_RESULT_CODE = 11;
const SQLITE_NOTADB_RESULT_CODE = 26;
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;

export function sqliteErrorCode(error: unknown): string | undefined {
  const code = asOptionalObjectRecord(error)?.code;
  return typeof code === "string" ? code : undefined;
}

export function sqliteExtendedResultCode(error: unknown): number | undefined {
  const errcode = asOptionalObjectRecord(error)?.errcode;
  return typeof errcode === "number" && Number.isInteger(errcode) ? errcode : undefined;
}

export function sqlitePrimaryResultCode(error: unknown): number | undefined {
  const errcode = sqliteExtendedResultCode(error);
  return errcode === undefined ? undefined : errcode & SQLITE_PRIMARY_RESULT_CODE_MASK;
}

export function isSqliteLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code !== undefined && SQLITE_LOCK_ERROR_CODES.has(code)) {
    return true;
  }
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_BUSY_RESULT_CODE || primaryCode === SQLITE_LOCKED_RESULT_CODE;
}

/** Report proven file damage (corrupt page or non-database header), not transient failure. */
export function isSqliteCorruptionError(error: unknown): boolean {
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_CORRUPT_RESULT_CODE || primaryCode === SQLITE_NOTADB_RESULT_CODE;
}
