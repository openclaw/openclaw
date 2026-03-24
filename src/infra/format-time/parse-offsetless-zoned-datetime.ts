const OFFSETLESS_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

export function isOffsetlessIsoDateTime(raw: string): boolean {
  return OFFSETLESS_ISO_DATETIME_RE.test(raw);
}

export function parseOffsetlessIsoDateTimeInTimeZone(raw: string, timeZone: string): string | null {
  if (!isOffsetlessIsoDateTime(raw)) {
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());

    const naiveMs = new Date(`${raw}Z`).getTime();
    if (Number.isNaN(naiveMs)) {
      return null;
    }

    // Re-check the offset at the first candidate instant so DST boundaries
    // land on the intended wall-clock time instead of drifting by one hour.
    const firstOffsetMs = getTimeZoneOffsetMs(naiveMs, timeZone);
    const candidateMs = naiveMs - firstOffsetMs;
    const finalOffsetMs = getTimeZoneOffsetMs(candidateMs, timeZone);
    return new Date(naiveMs - finalOffsetMs).toISOString();
  } catch {
    return null;
  }
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const utcDate = new Date(utcMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);

  const getNumericPart = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type);
    return Number.parseInt(part?.value ?? "0", 10);
  };

  const localAsUtc = Date.UTC(
    getNumericPart("year"),
    getNumericPart("month") - 1,
    getNumericPart("day"),
    getNumericPart("hour"),
    getNumericPart("minute"),
    getNumericPart("second"),
  );

  return localAsUtc - utcMs;
}
