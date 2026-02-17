const INTEGER_PATTERN = /^[+-]?\d+$/;

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
    if (!trimmed || !INTEGER_PATTERN.test(trimmed)) {
      return undefined;
    }
    value = Number(trimmed);
  }

  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    return undefined;
  }

  return value;
}
