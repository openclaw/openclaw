import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";

export const DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY = 1000;
const DEFAULT_DIAGNOSTIC_STABILITY_LIMIT = 50;
export const MAX_DIAGNOSTIC_STABILITY_LIMIT = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY;

type DiagnosticStabilityQueryInput = {
  limit?: unknown;
  type?: unknown;
  sinceSeq?: unknown;
};

type NormalizedDiagnosticStabilityQuery = {
  limit: number;
  type: string | undefined;
  sinceSeq: number | undefined;
};

function parseOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    // Gate on strict decimal digits before parsing so non-decimal forms such as
    // "0x2", "1e2", "0b101", "+5", or " 5 " are rejected instead of coerced.
    if (!/^\d+$/.test(value)) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("type must be a non-empty string");
  }
  return value.trim();
}

function normalizeLimit(limit: unknown, defaultLimit = DEFAULT_DIAGNOSTIC_STABILITY_LIMIT): number {
  const parsed = parseOptionalNonNegativeInteger(limit, "limit");
  if (parsed === undefined) {
    return defaultLimit;
  }
  if (parsed < 1 || parsed > MAX_DIAGNOSTIC_STABILITY_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_DIAGNOSTIC_STABILITY_LIMIT}`);
  }
  return parsed;
}

/** Normalizes user-facing snapshot query options. */
export function normalizeDiagnosticStabilityQuery(
  input: DiagnosticStabilityQueryInput = {},
  options?: { defaultLimit?: number },
): NormalizedDiagnosticStabilityQuery {
  return {
    limit: normalizeLimit(input.limit, options?.defaultLimit),
    type: parseOptionalType(input.type),
    sinceSeq: parseOptionalNonNegativeInteger(input.sinceSeq, "sinceSeq"),
  };
}
