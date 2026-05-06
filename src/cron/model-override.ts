const CRON_MODEL_INHERIT_SENTINELS = new Set(["default", "null"]);

export function normalizeCronPayloadModelOverride(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || CRON_MODEL_INHERIT_SENTINELS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

export function hasCronPayloadModelOverride(value: unknown): boolean {
  return normalizeCronPayloadModelOverride(value) !== undefined;
}
