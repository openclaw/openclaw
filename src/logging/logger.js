import fs from "node:fs";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { readLoggingConfig } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import { loggingState } from "./state.js";
import { formatLocalIsoWithOffset } from "./timestamps.js";
export const DEFAULT_LOG_DIR = resolvePreferredOpenClawTmpDir();
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "openclaw.log"); // legacy single-file path
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024; // 500 MB
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const externalTransports = new Set();
function attachExternalTransport(logger, transport) {
    logger.attachTransport((logObj) => {
        if (!externalTransports.has(transport)) {
            return;
        }
        try {
            transport(logObj);
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
    if (!cfg) {
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
    if (settings.level === "silent") {
        return false;
    }
    return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}
function buildLogger(settings) {
    const logger = new TsLogger({
        name: "openclaw",
        minLevel: levelToMinLevel(settings.level),
        type: "hidden", // no ansi formatting
    });
    // Silent logging does not write files; skip all filesystem setup in this path.
    if (settings.level === "silent") {
        for (const transport of externalTransports) {
            attachExternalTransport(logger, transport);
        }
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
            const time = formatLocalIsoWithOffset(logObj.date ?? new Date());
            const line = JSON.stringify({ ...logObj, time });
            const payload = `${line}\n`;
            const payloadBytes = Buffer.byteLength(payload, "utf8");
            const nextBytes = currentFileBytes + payloadBytes;
            if (nextBytes > settings.maxFileBytes) {
                if (!warnedAboutSizeCap) {
                    warnedAboutSizeCap = true;
                    const warningLine = JSON.stringify({
                        time: formatLocalIsoWithOffset(new Date()),
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
    for (const transport of externalTransports) {
        attachExternalTransport(logger, transport);
    }
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
    const minLevel = opts?.level ? levelToMinLevel(opts.level) : undefined;
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
export function registerLogTransport(transport) {
    externalTransports.add(transport);
    const logger = loggingState.cachedLogger;
    if (logger) {
        attachExternalTransport(logger, transport);
    }
    return () => {
        externalTransports.delete(transport);
    };
}
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
