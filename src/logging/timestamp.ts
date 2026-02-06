/** Format a Date as local ISO-8601 with milliseconds and timezone offset. */
export function formatLocalIso(date?: Date): string {
  const d = date ?? new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** Extract local date portion (YYYY-MM-DD) from a Date. */
export function localDateStr(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Extract local time portion (HH:MM:SS) from a Date. */
export function localTimeStr(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Get timezone offset label like "+08:00" from a Date. */
export function tzOffsetLabel(date?: Date): string {
  const d = date ?? new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
