import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function visitConfigValueTree(
  value: unknown,
  visit: (candidate: unknown, path: readonly string[]) => boolean,
  rootPath: readonly string[] = [],
): void {
  type Frame = { kind: "leave" } | { kind: "visit"; value: unknown; key?: string };
  const currentPath = [...rootPath];
  const pending: Frame[] = [{ kind: "visit", value }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === "leave") {
      currentPath.pop();
      continue;
    }
    if (frame.key !== undefined) {
      currentPath.push(frame.key);
      pending.push({ kind: "leave" });
    }
    if (!visit(frame.value, currentPath)) {
      continue;
    }
    const entries =
      Array.isArray(frame.value) || isRecord(frame.value) ? Object.entries(frame.value) : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      pending.push({ kind: "visit", key, value: child });
    }
  }
}

export function rejectConfigNonFiniteNumbers(value: unknown): void {
  visitConfigValueTree(value, (candidate) => {
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`Value must be a finite number, got ${String(candidate)}`);
      }
    }
    return true;
  });
}

const JSON5_LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);
// A number literal at the scan position: sign, hex, or decimal with fraction and exponent.
const JSON5_NUMBER_AT_RE = /[+-]?(?:0[xX][\dA-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const JSON5_IDENTIFIER_CHAR_RE = /[\p{ID_Continue}$\\]/u;
// ZWNJ and ZWJ may also continue a JSON5 identifier.
const isJson5IdentifierChar = (char: string) =>
  JSON5_IDENTIFIER_CHAR_RE.test(char) || char === "\u200c" || char === "\u200d";
const DECIMAL_NUMBER_RE = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Number literals in source the JSON5 parser accepted, skipping strings (escapes include line
 * continuations), comments (`//` ends at any JSON5 line terminator) and identifiers as it does.
 */
function* json5NumberLiterals(raw: string): Generator<string> {
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '"' || char === "'") {
      index += 1;
      while (index < raw.length && raw[index] !== char) {
        index += raw[index] === "\\" ? 2 : 1;
      }
      index += 1;
    } else if (char === "/" && raw[index + 1] === "/") {
      while (index < raw.length && !JSON5_LINE_TERMINATORS.has(raw[index]!)) {
        index += 1;
      }
    } else if (char === "/" && raw[index + 1] === "*") {
      const end = raw.indexOf("*/", index + 2);
      index = end < 0 ? raw.length : end + 2;
    } else if (/[\d.+-]/.test(char)) {
      JSON5_NUMBER_AT_RE.lastIndex = index;
      const literal = JSON5_NUMBER_AT_RE.exec(raw)?.[0];
      if (literal) {
        yield literal;
      }
      index += literal?.length || 1;
    } else if (isJson5IdentifierChar(char)) {
      // A key or keyword such as `id1471383327500481391` or `Infinity` is not a number.
      while (index < raw.length && isJson5IdentifierChar(raw[index]!)) {
        index += 1;
      }
    } else {
      index += 1;
    }
  }
}

/** The number JSON5 stores for a literal; the sign is applied separately, as for hex. */
function json5StoredNumber(literal: string): number {
  const magnitude = Number(literal.replace(/^[+-]/, ""));
  return literal.startsWith("-") ? -magnitude : magnitude;
}

/** The exact integer a literal denotes, or undefined when it is not an integer (or absurdly large). */
function exactIntegerValue(literal: string): bigint | undefined {
  const negative = literal.startsWith("-");
  const unsigned = literal.replace(/^[+-]/, "");
  let value: bigint;
  if (/^0[xX]/.test(unsigned)) {
    value = BigInt(unsigned);
  } else {
    const match = DECIMAL_NUMBER_RE.exec(unsigned);
    if (!match) {
      return undefined;
    }
    const fraction = match[2] ?? "";
    let digits = `${match[1] ?? ""}${fraction}`.replace(/^0+/, "");
    let exponent = Number(match[3] ?? 0) - fraction.length;
    while (exponent < 0 && digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      exponent += 1;
    }
    if (!digits) {
      return 0n;
    }
    // A fraction is not an id; past 1e330 the finite-number check already refuses it.
    if (exponent < 0 || digits.length + exponent > 330) {
      return undefined;
    }
    value = BigInt(digits) * 10n ** BigInt(exponent);
  }
  return negative ? -value : value;
}

/**
 * Reject number literals that would be saved as a different number: an unquoted 19-digit sender
 * id beyond Number.MAX_SAFE_INTEGER is rounded while it is parsed, so a different id would be
 * saved. Only an integer whose saved text denotes another value is refused; one saved as the
 * value written (2^54, 1.5e300, or the rounded id typed back) passes. Runs on new input text
 * only, so configs saved before this check still load and write.
 */
export function rejectConfigLostIntegerDigits(raw: string): void {
  for (const literal of json5NumberLiterals(raw)) {
    const exact = exactIntegerValue(literal);
    if (exact === undefined || (exact <= MAX_SAFE && exact >= -MAX_SAFE)) {
      continue;
    }
    const stored = json5StoredNumber(literal);
    if (exactIntegerValue(String(stored)) !== exact) {
      throw new Error(
        `${literal} would be saved as a different number (${String(stored)}); quote it as a string`,
      );
    }
  }
}

export function isUnsafeConfigInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value);
}
