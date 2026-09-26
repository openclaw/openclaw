import { coerceErrorMessage, extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const STORAGE_ERRORS = [
  ["SQLITE_BUSY", "database is locked", 5],
  ["SQLITE_LOCKED", "database table is locked", 6],
  ["SQLITE_READONLY", "attempt to write a readonly database", 8],
  ["SQLITE_IOERR", "disk I/O error", 10],
  ["SQLITE_FULL", "database or disk is full", 13],
  ["transcript_writer_fenced", "session writer claim changed before transcript persistence", -1],
] as const;
export type GatewayStorageFailure = (typeof STORAGE_ERRORS)[number][0];

/** Classify native errors before flattening; legacy rows require exact known messages. */
export function classifyGatewayStorageFailure(error: unknown): GatewayStorageFailure | undefined {
  const fields = typeof error === "string" ? { message: error } : isRecord(error) ? error : {};
  const code = fields.errorCode ?? fields.code;
  const nativeCode = fields.errcode;
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
      [fields.errstr, fields.errorMessage, fields.message].some(
        (value) => typeof value === "string" && value.trim() === message,
      ),
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
