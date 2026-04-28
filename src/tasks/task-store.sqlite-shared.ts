export function normalizeSqliteNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

export function serializeOptionalJson(
  value: unknown,
  options: { preserveNull?: boolean } = {},
): string | null {
  if (value === undefined) {
    return null;
  }
  if (value === null && options.preserveNull !== true) {
    return null;
  }
  return JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
export function parseOptionalJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
