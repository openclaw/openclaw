export const HIGH_FREQUENCY_EVERY_WARNING_THRESHOLD_MS = 30 * 60_000;

export function isHighFrequencyEverySchedule(
  schedule: { kind?: string; everyMs?: number } | null | undefined,
): schedule is { kind: "every"; everyMs: number } {
  return (
    schedule?.kind === "every" &&
    typeof schedule.everyMs === "number" &&
    Number.isFinite(schedule.everyMs) &&
    schedule.everyMs > 0 &&
    schedule.everyMs < HIGH_FREQUENCY_EVERY_WARNING_THRESHOLD_MS
  );
}

export function getHighFrequencyEveryWarningMessage(): string {
  return (
    "Warning: high-frequency cron schedules (<30m) may cause session accumulation and silently exhaust " +
    "the agent context window. Consider heartbeat or a longer interval."
  );
}
