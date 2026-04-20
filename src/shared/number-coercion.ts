export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asInteger(value: unknown): number | undefined {
  const num = asFiniteNumber(value);
  return num !== undefined && Number.isInteger(num) ? num : undefined;
}

export function asPositiveNumber(value: unknown): number | undefined {
  const num = asFiniteNumber(value);
  return num !== undefined && num > 0 ? num : undefined;
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  const num = asFiniteNumber(value);
  return num !== undefined && num >= 0 ? num : undefined;
}

export function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return asFiniteNumber(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return asFiniteNumber(parsed);
  }
  return undefined;
}

export function normalizeInteger(value: unknown): number | undefined {
  const num = normalizeNumber(value);
  if (num !== undefined) {
    return Math.floor(num);
  }
  return undefined;
}

export function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const num = asFiniteNumber(value);
  if (num !== undefined) {
    return Math.max(min, Math.min(max, num));
  }
  return undefined;
}
