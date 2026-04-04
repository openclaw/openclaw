export const ALLOWED_LOG_LEVELS = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export type LogLevel = (typeof ALLOWED_LOG_LEVELS)[number];

export function tryParseLogLevel(level?: string): LogLevel | undefined {
  if (typeof level !== "string") {
    return undefined;
  }
  const candidate = level.trim();
  return ALLOWED_LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : undefined;
}

export function normalizeLogLevel(level?: string, fallback: LogLevel = "info") {
  return tryParseLogLevel(level) ?? fallback;
}

export function levelToMinLevel(level: LogLevel): number {
  // tslog level ordering: fatal=0, error=1, warn=2, info=3, debug=4, trace=5
  const map: Record<LogLevel, number> = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}
