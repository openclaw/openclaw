export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}

export function hasNonEmptyString(value: unknown): value is string {
  return normalizeOptionalString(value) !== undefined;
}
