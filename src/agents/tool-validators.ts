import type { ToolValidator } from "../config/types.tools.js";

/**
 * Safely evaluate a simple predicate expression against a value.
 * NOT eval() — only supports comparison operators on the $ placeholder.
 *
 * Supported: $ > N, $ < N, $ >= N, $ <= N, $ === V, $ !== V, $.length < N
 * Combinators: && (all must pass), || (any must pass)
 */
function evaluateSimplePredicate(expr: string, value: unknown): boolean {
  // Handle && (all clauses must pass)
  if (expr.includes("&&")) {
    return expr
      .split("&&")
      .map((c) => c.trim())
      .every((clause) => evaluateSimplePredicate(clause, value));
  }
  // Handle || (any clause must pass)
  if (expr.includes("||")) {
    return expr
      .split("||")
      .map((c) => c.trim())
      .some((clause) => evaluateSimplePredicate(clause, value));
  }

  const trimmed = expr.trim();

  // $.length comparisons
  const lengthMatch = trimmed.match(/^\$\.length\s*(>=|<=|>|<|===|!==)\s*(.+)$/);
  if (lengthMatch) {
    const len =
      typeof value === "string" ? value.length : Array.isArray(value) ? value.length : undefined;
    if (len === undefined) {
      return false;
    }
    return compareValues(len, lengthMatch[1], parseOperand(lengthMatch[2]));
  }

  // Direct $ comparisons
  const directMatch = trimmed.match(/^\$\s*(>=|<=|>|<|===|!==)\s*(.+)$/);
  if (directMatch) {
    return compareValues(value, directMatch[1], parseOperand(directMatch[2]));
  }

  return true; // Unknown expression format — don't block
}

function parseOperand(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  const num = Number(trimmed);
  if (!Number.isNaN(num)) {
    return num;
  }
  return trimmed;
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  const l = typeof left === "number" ? left : Number(left);
  const r = typeof right === "number" ? right : Number(right);
  const numericOk = !Number.isNaN(l) && !Number.isNaN(r);

  switch (op) {
    case ">":
      return numericOk && l > r;
    case "<":
      return numericOk && l < r;
    case ">=":
      return numericOk && l >= r;
    case "<=":
      return numericOk && l <= r;
    case "===":
      return left === right || (numericOk && l === r);
    case "!==":
      return left !== right && (!numericOk || l !== r);
    default:
      return true;
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate tool validators against a tool call's parameters.
 * Returns a rejection message string if a validator fails, null if all pass.
 */
export function evaluateToolValidators(
  toolName: string,
  params: Record<string, unknown>,
  validators: ToolValidator[],
): string | null {
  for (const v of validators) {
    if (v.tool !== toolName) {
      continue;
    }
    const value = getNestedValue(params, v.field);
    if (value === undefined) {
      continue;
    } // field not present = skip
    const pass = evaluateSimplePredicate(v.assert, value);
    if (!pass) {
      return (
        v.message ??
        `Validation failed for ${v.tool}.${v.field}: ${v.assert} (got ${JSON.stringify(value)})`
      );
    }
  }
  return null;
}

/** @internal — exported for unit tests only */
export const __testing = { evaluateSimplePredicate, getNestedValue, compareValues };
