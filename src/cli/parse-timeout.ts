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
    if (!/^-?\d+$/.test(trimmed)) {
      return undefined;
    }
    value = Number(trimmed);
  }
  return Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

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
    throw new Error("invalid --timeout");
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  return parsed;
}
