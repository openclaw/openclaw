export function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "bigint") {
    value = Number(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    value = Number.parseInt(trimmed, 10);
  }
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Same as parseTimeoutMs, but always returns a number instead of undefined.
 * - If the value is missing (undefined/null) or empty string, returns fallbackMs.
 * - If the value is the wrong type, returns fallbackMs by default; throws if options.invalidType is "error".
 * - If the value is present but not a valid positive number, throws an error.
 */
export function parseTimeoutMsWithFallback(
  raw: unknown,
  fallbackMs: number,
  options: {
    invalidType?: "fallback" | "error";
  } = {},
): number {
  if (raw === undefined || raw === null) {
    return fallbackMs;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : null;

  if (value === null) {
    if (options.invalidType === "error") {
      throw new Error("invalid --timeout");
    }
    return fallbackMs;
  }

  if (!value) {
    return fallbackMs;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  return parsed;
}
