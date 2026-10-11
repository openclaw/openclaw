import {
  readJsonPredicateScalar,
  scanJsonObjectFields,
  type JsonPredicateToken,
} from "../../state/json-predicate-fields.js";

const MIN_SQLITE_INTEGER = -(1n << 63n);
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;
const REFERENCE_FIELDS = [
  "previousSessionId",
  "usageFamilySessionIds",
  "compactionCheckpoints",
] as const;

/** Preserve SQLite CAST(... AS INTEGER), including legacy numeric strings. */
function sessionStartedAt(token: JsonPredicateToken | undefined): number | bigint | null {
  if (!token || token.kind === "null") {
    return null;
  }
  const value = readJsonPredicateScalar(token);
  let integer: bigint;
  if (token.kind === "string") {
    const digits = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(String(value));
    integer = digits ? BigInt(digits[1]) : 0n;
  } else if (token.kind === "number") {
    if (/^-?\d+$/.test(token.text)) {
      integer = BigInt(token.text);
    } else {
      const number = Number(value);
      integer = Number.isFinite(number)
        ? BigInt(Math.trunc(number))
        : number > 0
          ? MAX_SQLITE_INTEGER
          : MIN_SQLITE_INTEGER;
    }
  } else {
    integer = value === true ? 1n : 0n;
  }
  integer = integer < MIN_SQLITE_INTEGER ? MIN_SQLITE_INTEGER : integer;
  integer = integer > MAX_SQLITE_INTEGER ? MAX_SQLITE_INTEGER : integer;
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(integer)
    : integer;
}

/** The writer, migration parity proof, and actor use the same derived facts. */
export function deriveSessionPredicateColumns(entryJson: string): {
  session_started_at: number | bigint | null;
  has_optional_references: number;
} {
  const fields = scanJsonObjectFields(entryJson, ["sessionStartedAt", ...REFERENCE_FIELDS]);
  const valid = fields.valid && fields.maximumDepth <= 1000;
  return {
    session_started_at: valid ? sessionStartedAt(fields.first.get("sessionStartedAt")) : null,
    has_optional_references:
      !valid ||
      entryJson.includes("\0") ||
      REFERENCE_FIELDS.some((field) => fields.first.has(field))
        ? 1
        : 0,
  };
}
