// systemd.time(7) durations from unit files and systemctl show (USec properties
// are printed as human-readable spans, not bare microseconds).
export const SYSTEMD_DEFAULT_STOP_TIMEOUT_MS = 90_000;
const UNITS: Record<string, number> = {
  us: 0.001,
  usec: 0.001,
  μs: 0.001,
  ms: 1,
  msec: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  M: 2_629_800_000,
  month: 2_629_800_000,
  months: 2_629_800_000,
  y: 31_557_600_000,
  year: 31_557_600_000,
  years: 31_557_600_000,
};

export function parseSystemdTimeSpanMs(value: string): number | undefined {
  const text = value.trim();
  if (text === "infinity") {
    return Infinity;
  }
  let remaining = text;
  let total = 0;
  if (!remaining) {
    return undefined;
  }
  while (remaining) {
    const match = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-zA-Zμ]+)?\s*/u.exec(remaining);
    if (!match) {
      return undefined;
    }
    const factor = match[2] ? UNITS[match[2]] : 1_000;
    if (factor === undefined) {
      return undefined;
    }
    total += Number(match[1]) * factor;
    remaining = remaining.slice(match[0].length);
  }
  return Number.isFinite(total) ? total : undefined;
}
