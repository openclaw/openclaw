// systemd.time(7) durations from unit files and systemctl show (USec properties
// are printed as human-readable spans, not bare microseconds).
export const SYSTEMD_DEFAULT_STOP_TIMEOUT_MS = 90_000;
const UNITS: Record<string, number> = Object.fromEntries(
  (
    [
      ["us usec μs", 0.001],
      ["ms msec", 1],
      ["s sec second seconds", 1_000],
      ["m min minute minutes", 60_000],
      ["h hr hour hours", 3_600_000],
      ["d day days", 86_400_000],
      ["w week weeks", 604_800_000],
      ["M month months", 2_629_800_000],
      ["y year years", 31_557_600_000],
    ] as const
  ).flatMap(([aliases, multiplier]) =>
    aliases.split(" ").map((alias) => [alias, multiplier] as const),
  ),
);

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
