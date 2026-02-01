const ISO_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;
const ISO_DATE_TIME_SPACE_RE = /^\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/;

function normalizeUtcIso(raw: string) {
  if (ISO_TZ_RE.test(raw)) {
    return raw;
  }
  if (ISO_DATE_RE.test(raw)) {
    return `${raw}T00:00:00Z`;
  }
  if (ISO_DATE_TIME_RE.test(raw)) {
    return `${raw}Z`;
  }
  return raw;
}

function formatUtcMsInZone(ms: number, timeZone: string): string {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }
  const y = map.year ?? "0000";
  const mo = map.month ?? "01";
  const day = map.day ?? "01";
  const h = map.hour ?? "00";
  const min = map.minute ?? "00";
  const s = map.second ?? "00";
  return `${y}-${mo}-${day} ${h}:${min}:${s}`;
}

function parseLocalTimeInZone(localStr: string, timeZone: string): number | null {
  const normalized = localStr.trim().replace(/[T\s]+/, " ");
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/,
  );
  if (!match) {
    return null;
  }
  const [, y, mo, day, h, min, s, frac] = match;
  const sec = s ? Number(s) : 0;
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  const target = `${y}-${mo}-${day} ${h.padStart(2, "0")}:${min}:${String(sec).padStart(2, "0")}`;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    return null;
  }

  const trialMs = Date.parse(
    `${y}-${mo}-${day}T${h.padStart(2, "0")}:${min}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`,
  );
  if (!Number.isFinite(trialMs)) {
    return null;
  }
  const halfDay = 12 * 60 * 60 * 1000;
  let low = trialMs - halfDay;
  let high = trialMs + halfDay;
  const roundToSecond = (n: number) => (ms === 0 ? Math.floor(n / 1000) * 1000 : n);
  for (let i = 0; i < 30; i++) {
    const mid = Math.floor((low + high) / 2);
    const formatted = formatUtcMsInZone(mid, timeZone);
    if (formatted === target) {
      return roundToSecond(mid);
    }
    if (formatted < target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const mid = Math.floor((low + high) / 2);
  const result = formatUtcMsInZone(mid, timeZone) === target ? mid : null;
  if (result === null) {
    return null;
  }
  return roundToSecond(result);
}

export function parseAbsoluteTimeMs(input: string, tz?: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
  }
  if (ISO_TZ_RE.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (tz && ISO_DATE_TIME_SPACE_RE.test(raw)) {
    const inTz = parseLocalTimeInZone(raw, tz);
    return inTz;
  }
  if (tz && ISO_DATE_RE.test(raw)) {
    return null;
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
