export const ALLOWED_LOG_LEVELS = [
    "silent",
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
];
export function tryParseLogLevel(level) {
    if (typeof level !== "string") {
        return undefined;
    }
    const candidate = level.trim();
    return ALLOWED_LOG_LEVELS.includes(candidate) ? candidate : undefined;
}
export function normalizeLogLevel(level, fallback = "info") {
    return tryParseLogLevel(level) ?? fallback;
}
export function levelToMinLevel(level) {
    // tslog v4 logLevelId (src/index.ts): silly=0, trace=1, debug=2, info=3, warn=4, error=5, fatal=6
    // tslog filters: logLevelId < minLevel is dropped, so higher minLevel = more restrictive.
    const map = {
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
