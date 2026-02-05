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

export function normalizeLogLevel(level?: string, fallback: LogLevel = "info") {
  const candidate = (level ?? fallback).trim();
  return ALLOWED_LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : fallback;
}

export function levelToMinLevel(level: LogLevel): number {
  // Matches tslog v4 level IDs: higher number = more severe.
  // tslog logs messages with logLevelId >= minLevel.
  const map: Record<LogLevel, number> = {
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
    fatal: 6,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}
