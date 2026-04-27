import fs from "node:fs";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { isValidDiagnosticSpanId, isValidDiagnosticTraceFlags, isValidDiagnosticTraceId, } from "../infra/diagnostic-trace-context.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { POSIX_OPENCLAW_TMP_DIR, resolvePreferredOpenClawTmpDir, } from "../infra/tmp-openclaw-dir.js";
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import { redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";
function canUseNodeFs() {
    const getBuiltinModule = process.getBuiltinModule;
    if (typeof getBuiltinModule !== "function") {
        return false;
    }
    try {
        return getBuiltinModule("fs") !== undefined;
    }
    catch {
        return false;
    }
}
function resolveDefaultLogDir() {
    return canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
}
function resolveDefaultLogFile(defaultLogDir) {
    return canUseNodeFs()
        ? path.join(defaultLogDir, "openclaw.log")
        : `${POSIX_OPENCLAW_TMP_DIR}/openclaw.log`;
}
export const DEFAULT_LOG_DIR = resolveDefaultLogDir();
export const DEFAULT_LOG_FILE = resolveDefaultLogFile(DEFAULT_LOG_DIR); // legacy single-file path
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024; // 500 MB
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS = 8 * 1024;
const MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT = 32;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS = 2 * 1024;
const MAX_DIAGNOSTIC_LOG_NAME_CHARS = 120;
const DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
function clampDiagnosticLogText(value, maxChars) {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}
function sanitizeDiagnosticLogText(value, maxChars) {
    return clampDiagnosticLogText(redactSensitiveText(clampDiagnosticLogText(value, maxChars)), maxChars);
}
function normalizeDiagnosticLogName(value) {
    if (!value || value.trim().startsWith("{")) {
        return undefined;
    }
    const sanitized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS);
    return DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(sanitized) ? sanitized : undefined;
}
function assignDiagnosticLogAttribute(attributes, state, key, value) {
    if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
        return;
    }
    const normalizedKey = key.trim();
    if (isBlockedObjectKey(normalizedKey)) {
        return;
    }
    if (redactSensitiveText(normalizedKey) !== normalizedKey) {
        return;
    }
    if (!DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(normalizedKey)) {
        return;
    }
    if (typeof value === "string") {
        attributes[normalizedKey] = sanitizeDiagnosticLogText(value, MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS);
        state.count += 1;
        return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        attributes[normalizedKey] = value;
        state.count += 1;
        return;
    }
    if (typeof value === "boolean") {
        attributes[normalizedKey] = value;
        state.count += 1;
    }
}
function addDiagnosticLogAttributesFrom(attributes, state, source) {
    if (!source) {
        return;
    }
    for (const key in source) {
        if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
            break;
        }
        if (!Object.hasOwn(source, key) || key === "trace") {
            continue;
        }
        assignDiagnosticLogAttribute(attributes, state, key, source[key]);
    }
}
function isPlainLogRecordObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function normalizeTraceContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value;
    if (!isValidDiagnosticTraceId(candidate.traceId)) {
        return undefined;
    }
    if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
        return undefined;
    }
    if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
        return undefined;
    }
    if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
        return undefined;
    }
    return {
        traceId: candidate.traceId,
        ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
        ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
        ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
    };
}
function extractTraceContext(value) {
    const direct = normalizeTraceContext(value);
    if (direct) {
        return direct;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return normalizeTraceContext(value.trace);
}
function findLogTraceContext(bindings, numericArgs) {
    const fromBindings = extractTraceContext(bindings);
    if (fromBindings) {
        return fromBindings;
    }
    for (const arg of numericArgs) {
        const fromArg = extractTraceContext(arg);
        if (fromArg) {
            return fromArg;
        }
    }
    return undefined;
}
function buildDiagnosticLogRecord(logObj) {
    const meta = logObj._meta;
    const numericArgs = Object.entries(logObj)
        .filter(([key]) => /^\d+$/.test(key))
        .toSorted((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, value]) => value);
    let bindings;
    if (typeof numericArgs[0] === "string" &&
        numericArgs[0].length <= MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS &&
        numericArgs[0].trim().startsWith("{")) {
        try {
            const parsed = JSON.parse(numericArgs[0]);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                bindings = parsed;
                numericArgs.shift();
            }
        }
        catch {
            // ignore malformed json bindings
        }
    }
    const trace = findLogTraceContext(bindings, numericArgs);
    const structuredArg = numericArgs[0];
    const structuredBindings = isPlainLogRecordObject(structuredArg) ? structuredArg : undefined;
    if (structuredBindings) {
        numericArgs.shift();
    }
    let message = "";
    if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
        message = sanitizeDiagnosticLogText(String(numericArgs.pop()), MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS);
    }
    else if (numericArgs.length === 1 &&
        (typeof numericArgs[0] === "number" || typeof numericArgs[0] === "boolean")) {
        message = String(numericArgs[0]);
        numericArgs.length = 0;
    }
    if (!message) {
        message = "log";
    }
    const attributes = Object.create(null);
    const attributeState = { count: 0 };
    addDiagnosticLogAttributesFrom(attributes, attributeState, bindings);
    addDiagnosticLogAttributesFrom(attributes, attributeState, structuredBindings);
    const code = {};
    if (meta?.path?.fileLine) {
        const line = Number(meta.path.fileLine);
        if (Number.isFinite(line)) {
            code.line = line;
        }
    }
    if (meta?.path?.method) {
        code.functionName = sanitizeDiagnosticLogText(meta.path.method, MAX_DIAGNOSTIC_LOG_NAME_CHARS);
    }
    const loggerName = normalizeDiagnosticLogName(meta?.name);
    const loggerParents = meta?.parentNames
        ?.map(normalizeDiagnosticLogName)
        .filter((name) => Boolean(name));
    return {
        type: "log.record",
        level: meta?.logLevelName ?? "INFO",
        message,
        ...(loggerName ? { loggerName } : {}),
        ...(loggerParents?.length ? { loggerParents } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(Object.keys(code).length > 0 ? { code } : {}),
        ...(trace ? { trace } : {}),
    };
}
function attachDiagnosticEventTransport(logger) {
    logger.attachTransport((logObj) => {
        try {
            emitDiagnosticEvent(buildDiagnosticLogRecord(logObj));
        }
        catch {
            // never block on logging failures
        }
    });
}
function canUseSilentVitestFileLogFastPath(envLevel) {
    return (process.env.VITEST === "true" &&
        process.env.OPENCLAW_TEST_FILE_LOG !== "1" &&
        !envLevel &&
        !loggingState.overrideSettings);
}
function resolveSettings() {
    if (!canUseNodeFs()) {
        return {
            level: "silent",
            file: DEFAULT_LOG_FILE,
            maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
        };
    }
    const envLevel = resolveEnvLogLevelOverride();
    // Test runs default file logs to silent. Skip config reads and fallback load in the
    // common case to avoid pulling heavy config/schema stacks on startup.
    if (canUseSilentVitestFileLogFastPath(envLevel)) {
        return {
            level: "silent",
            file: defaultRollingPathForToday(),
            maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
        };
    }
    let cfg = loggingState.overrideSettings ?? readLoggingConfig();
    if (!cfg && !shouldSkipMutatingLoggingConfigRead()) {
        try {
            const loaded = requireConfig?.("../config/config.js");
            cfg = loaded?.loadConfig?.().logging;
        }
        catch {
            cfg = undefined;
        }
    }
    const defaultLevel = process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
    const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
    const level = envLevel ?? fromConfig;
    const file = cfg?.file ?? defaultRollingPathForToday();
    const maxFileBytes = resolveMaxLogFileBytes(cfg?.maxFileBytes);
    return { level, file, maxFileBytes };
}
function settingsChanged(a, b) {
    if (!a) {
        return true;
    }
    return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}
export function isFileLogLevelEnabled(level) {
    const settings = loggingState.cachedSettings ?? resolveSettings();
    if (!loggingState.cachedSettings) {
        loggingState.cachedSettings = settings;
    }
    if (level === "silent") {
        return false;
    }
    if (settings.level === "silent") {
        return false;
    }
    return levelToMinLevel(level) >= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
    const logger = new TsLogger({
        name: "openclaw",
        minLevel: levelToMinLevel(settings.level),
        type: "hidden", // no ansi formatting
    });
    // Silent logging does not write files; skip all filesystem setup in this path.
    if (settings.level === "silent") {
        attachDiagnosticEventTransport(logger);
        return logger;
    }
    fs.mkdirSync(path.dirname(settings.file), { recursive: true });
    // Clean up stale rolling logs when using a dated log filename.
    if (isRollingPath(settings.file)) {
        pruneOldRollingLogs(path.dirname(settings.file));
    }
    let currentFileBytes = getCurrentLogFileBytes(settings.file);
    let warnedAboutSizeCap = false;
    logger.attachTransport((logObj) => {
        try {
            const time = formatTimestamp(logObj.date ?? new Date(), { style: "long" });
            const line = JSON.stringify({ ...logObj, time });
            const payload = `${line}\n`;
            const payloadBytes = Buffer.byteLength(payload, "utf8");
            const nextBytes = currentFileBytes + payloadBytes;
            if (nextBytes > settings.maxFileBytes) {
                if (!warnedAboutSizeCap) {
                    warnedAboutSizeCap = true;
                    const warningLine = JSON.stringify({
                        time: formatTimestamp(new Date(), { style: "long" }),
                        level: "warn",
                        subsystem: "logging",
                        message: `log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}`,
                    });
                    appendLogLine(settings.file, `${warningLine}\n`);
                    process.stderr.write(`[openclaw] log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}\n`);
                }
                return;
            }
            if (appendLogLine(settings.file, payload)) {
                currentFileBytes = nextBytes;
            }
        }
        catch {
            // never block on logging failures
        }
    });
    attachDiagnosticEventTransport(logger);
    return logger;
}
function resolveMaxLogFileBytes(raw) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.floor(raw);
    }
    return DEFAULT_MAX_LOG_FILE_BYTES;
}
function getCurrentLogFileBytes(file) {
    try {
        return fs.statSync(file).size;
    }
    catch {
        return 0;
    }
}
function appendLogLine(file, line) {
    try {
        fs.appendFileSync(file, line, { encoding: "utf8" });
        return true;
    }
    catch {
        return false;
    }
}
export function getLogger() {
    const settings = resolveSettings();
    const cachedLogger = loggingState.cachedLogger;
    const cachedSettings = loggingState.cachedSettings;
    if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
        loggingState.cachedLogger = buildLogger(settings);
        loggingState.cachedSettings = settings;
    }
    return loggingState.cachedLogger;
}
export function getChildLogger(bindings, opts) {
    const base = getLogger();
    const minLevel = opts?.level ? levelToMinLevel(opts.level) : base.settings.minLevel;
    const name = bindings ? JSON.stringify(bindings) : undefined;
    return base.getSubLogger({
        name,
        minLevel,
        prefix: bindings ? [name ?? ""] : [],
    });
}
// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(logger, level) {
    const buildChild = (bindings) => toPinoLikeLogger(logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
        minLevel: logger.settings.minLevel,
    }), level);
    return {
        level,
        child: buildChild,
        trace: (...args) => logger.trace(...args),
        debug: (...args) => logger.debug(...args),
        info: (...args) => logger.info(...args),
        warn: (...args) => logger.warn(...args),
        error: (...args) => logger.error(...args),
        fatal: (...args) => logger.fatal(...args),
    };
}
export function getResolvedLoggerSettings() {
    return resolveSettings();
}
// Test helpers
export function setLoggerOverride(settings) {
    loggingState.overrideSettings = settings;
    loggingState.cachedLogger = null;
    loggingState.cachedSettings = null;
    loggingState.cachedConsoleSettings = null;
}
export function resetLogger() {
    loggingState.cachedLogger = null;
    loggingState.cachedSettings = null;
    loggingState.cachedConsoleSettings = null;
    loggingState.overrideSettings = null;
}
export const __test__ = {
    shouldSkipMutatingLoggingConfigRead,
};
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function defaultRollingPathForToday() {
    const today = formatLocalDate(new Date());
    return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}
function isRollingPath(file) {
    const base = path.basename(file);
    return (base.startsWith(`${LOG_PREFIX}-`) &&
        base.endsWith(LOG_SUFFIX) &&
        base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length);
}
function pruneOldRollingLogs(dir) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const cutoff = Date.now() - MAX_LOG_AGE_MS;
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
                continue;
            }
            const fullPath = path.join(dir, entry.name);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs < cutoff) {
                    fs.rmSync(fullPath, { force: true });
                }
            }
            catch {
                // ignore errors during pruning
            }
        }
    }
    catch {
        // ignore missing dir or read errors
    }
}
