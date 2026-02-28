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
  // OpenClaw internal ordering used for comparisons (e.g. isFileLogLevelEnabled):
  // fatal=0 (highest severity) … trace=5 (lowest severity).
  // Do NOT pass this directly to tslog — use levelToTslogMinLevel() instead.
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

export function levelToTslogMinLevel(level: LogLevel): number {
  // tslog's actual logLevelId ordering: silly=0, trace=1, debug=2, info=3, warn=4, error=5, fatal=6.
  // tslog filters with `if (logLevelId < minLevel) { return; }`, so passing minLevel=3
  // allows info(3), warn(4), error(5), fatal(6) and suppresses trace(1) and debug(2).
  // This is the correct mapping to use when constructing a TsLogger or calling getSubLogger.
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
