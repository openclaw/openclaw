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

// Strings and comments are blanked so digits inside them are never read as numbers.
const JSON5_STRING_OR_COMMENT_RE =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const JSON5_LONG_INTEGER_RE = /(?<![\w.$])-?\d{16,}(?![\w.])/g;

/**
 * Reject integer literals that parsing would store as a different number: an unquoted 19-digit
 * sender id beyond Number.MAX_SAFE_INTEGER is rounded, so a different id would be saved. Runs on
 * new input text only, so configs saved before this check still load and write.
 */
export function rejectConfigLostIntegerDigits(raw: string): void {
  const code = raw.replace(JSON5_STRING_OR_COMMENT_RE, (match) => " ".repeat(match.length));
  for (const [literal] of code.matchAll(JSON5_LONG_INTEGER_RE)) {
    const stored = Number(literal);
    if (String(stored) !== literal && BigInt(stored) !== BigInt(literal)) {
      throw new Error(
        `${literal} is too large to store exactly (it would be saved as ${String(stored)}); quote it as a string`,
      );
    }
  }
}

export function isUnsafeConfigInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value);
}
