const MAX_PORT = 65535;

export function parsePort(raw: unknown): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? raw.toString()
        : null;

  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_PORT) {
    return null;
  }

  return parsed;
}
