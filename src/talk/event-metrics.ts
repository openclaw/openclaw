export function talkEventPayloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function firstFiniteTalkEventNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}
