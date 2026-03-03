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
    // tslog level ordering: fatal=0, error=1, warn=2, info=3, debug=4, trace=5
    const map = {
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
