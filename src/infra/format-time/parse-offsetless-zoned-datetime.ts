const OFFSETLESS_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
const OFFSETLESS_ISO_DATETIME_PARTS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

type OffsetlessIsoDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

export function isOffsetlessIsoDateTime(raw: string): boolean {
  return OFFSETLESS_ISO_DATETIME_RE.test(raw);
}

export function parseOffsetlessIsoDateTimeInTimeZone(raw: string, timeZone: string): string | null {
  const expectedParts = parseOffsetlessIsoDateTimeParts(raw);
  if (!expectedParts) {
    return null;
  }
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
    const resolvedMs = naiveMs - finalOffsetMs;
    if (!matchesOffsetlessIsoDateTimeParts(resolvedMs, timeZone, expectedParts)) {
      return null;
    }
    return new Date(resolvedMs).toISOString();
  } catch {
    return null;
  }
}

function parseOffsetlessIsoDateTimeParts(raw: string): OffsetlessIsoDateTimeParts | null {
  const match = OFFSETLESS_ISO_DATETIME_PARTS_RE.exec(raw);
  if (!match) {
    return null;
  }
  const fractionalMs = (match[7] ?? "").padEnd(3, "0").slice(0, 3);
  return {
    year: Number.parseInt(match[1] ?? "0", 10),
    month: Number.parseInt(match[2] ?? "0", 10),
    day: Number.parseInt(match[3] ?? "0", 10),
    hour: Number.parseInt(match[4] ?? "0", 10),
    minute: Number.parseInt(match[5] ?? "0", 10),
    second: Number.parseInt(match[6] ?? "0", 10),
    millisecond: Number.parseInt(fractionalMs || "0", 10),
  };
}

function matchesOffsetlessIsoDateTimeParts(
  utcMs: number,
  timeZone: string,
  expected: OffsetlessIsoDateTimeParts,
): boolean {
  const utcDate = new Date(utcMs);
  if (utcDate.getUTCMilliseconds() !== expected.millisecond) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(utcDate);
  const getNumericPart = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type);
    return Number.parseInt(part?.value ?? "0", 10);
  };
  return (
    getNumericPart("year") === expected.year &&
    getNumericPart("month") === expected.month &&
    getNumericPart("day") === expected.day &&
    getNumericPart("hour") === expected.hour &&
    getNumericPart("minute") === expected.minute &&
    getNumericPart("second") === expected.second
  );
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
    hourCycle: "h23",
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
