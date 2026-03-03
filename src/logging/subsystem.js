import { Chalk } from "chalk";
import { isVerbose } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { getConsoleSettings, shouldLogSubsystemToConsole } from "./console.js";
import { levelToMinLevel } from "./levels.js";
import { getChildLogger, isFileLogLevelEnabled } from "./logger.js";
import { loggingState } from "./state.js";
function shouldLogToConsole(level, settings) {
    if (settings.level === "silent") {
        return false;
    }
    const current = levelToMinLevel(level);
    const min = levelToMinLevel(settings.level);
    return current <= min;
}
const inspectValue = (() => {
    const getBuiltinModule = process.getBuiltinModule;
    if (typeof getBuiltinModule !== "function") {
        return null;
    }
    try {
        const utilNamespace = getBuiltinModule("util");
        return typeof utilNamespace.inspect === "function" ? utilNamespace.inspect : null;
    }
    catch {
        return null;
    }
})();
function formatRuntimeArg(arg) {
    if (typeof arg === "string") {
        return arg;
    }
    if (inspectValue) {
        return inspectValue(arg);
    }
    try {
        return JSON.stringify(arg);
    }
    catch {
        return String(arg);
    }
}
function isRichConsoleEnv() {
    const term = (process.env.TERM ?? "").toLowerCase();
    if (process.env.COLORTERM || process.env.TERM_PROGRAM) {
        return true;
    }
    return term.length > 0 && term !== "dumb";
}
function getColorForConsole() {
    const hasForceColor = typeof process.env.FORCE_COLOR === "string" &&
        process.env.FORCE_COLOR.trim().length > 0 &&
        process.env.FORCE_COLOR.trim() !== "0";
    if (process.env.NO_COLOR && !hasForceColor) {
        return new Chalk({ level: 0 });
    }
    const hasTty = Boolean(process.stdout.isTTY || process.stderr.isTTY);
    return hasTty || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
const SUBSYSTEM_COLORS = ["cyan", "green", "yellow", "blue", "magenta", "red"];
const SUBSYSTEM_COLOR_OVERRIDES = {
    "gmail-watcher": "blue",
};
const SUBSYSTEM_PREFIXES_TO_DROP = ["gateway", "channels", "providers"];
const SUBSYSTEM_MAX_SEGMENTS = 2;
// Keep local to avoid importing channel registry into hot logging paths.
const CHANNEL_SUBSYSTEM_PREFIXES = new Set([
    "telegram",
    "whatsapp",
    "discord",
    "irc",
    "googlechat",
    "slack",
    "signal",
    "imessage",
]);
function pickSubsystemColor(color, subsystem) {
    const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
    if (override) {
        return color[override];
    }
    let hash = 0;
    for (let i = 0; i < subsystem.length; i += 1) {
        hash = (hash * 31 + subsystem.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % SUBSYSTEM_COLORS.length;
    const name = SUBSYSTEM_COLORS[idx];
    return color[name];
}
function formatSubsystemForConsole(subsystem) {
    const parts = subsystem.split("/").filter(Boolean);
    const original = parts.join("/") || subsystem;
    while (parts.length > 0 &&
        SUBSYSTEM_PREFIXES_TO_DROP.includes(parts[0])) {
        parts.shift();
    }
    if (parts.length === 0) {
        return original;
    }
    if (CHANNEL_SUBSYSTEM_PREFIXES.has(parts[0])) {
        return parts[0];
    }
    if (parts.length > SUBSYSTEM_MAX_SEGMENTS) {
        return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
    }
    return parts.join("/");
}
export function stripRedundantSubsystemPrefixForConsole(message, displaySubsystem) {
    if (!displaySubsystem) {
        return message;
    }
    // Common duplication: "[discord] discord: ..." (when a message manually includes the subsystem tag).
    if (message.startsWith("[")) {
        const closeIdx = message.indexOf("]");
        if (closeIdx > 1) {
            const bracketTag = message.slice(1, closeIdx);
            if (bracketTag.toLowerCase() === displaySubsystem.toLowerCase()) {
                let i = closeIdx + 1;
                while (message[i] === " ") {
                    i += 1;
                }
                return message.slice(i);
            }
        }
    }
    const prefix = message.slice(0, displaySubsystem.length);
    if (prefix.toLowerCase() !== displaySubsystem.toLowerCase()) {
        return message;
    }
    const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
    if (next !== ":" && next !== " ") {
        return message;
    }
    let i = displaySubsystem.length;
    while (message[i] === " ") {
        i += 1;
    }
    if (message[i] === ":") {
        i += 1;
    }
    while (message[i] === " ") {
        i += 1;
    }
    return message.slice(i);
}
function formatConsoleLine(opts) {
    const displaySubsystem = opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);
    if (opts.style === "json") {
        return JSON.stringify({
            time: new Date().toISOString(),
            level: opts.level,
            subsystem: displaySubsystem,
            message: opts.message,
            ...opts.meta,
        });
    }
    const color = getColorForConsole();
    const prefix = `[${displaySubsystem}]`;
    const prefixColor = pickSubsystemColor(color, displaySubsystem);
    const levelColor = opts.level === "error" || opts.level === "fatal"
        ? color.red
        : opts.level === "warn"
            ? color.yellow
            : opts.level === "debug" || opts.level === "trace"
                ? color.gray
                : color.cyan;
    const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
    const time = (() => {
        if (opts.style === "pretty") {
            return color.gray(new Date().toISOString().slice(11, 19));
        }
        if (loggingState.consoleTimestampPrefix) {
            return color.gray(new Date().toISOString());
        }
        return "";
    })();
    const prefixToken = prefixColor(prefix);
    const head = [time, prefixToken].filter(Boolean).join(" ");
    return `${head} ${levelColor(displayMessage)}`;
}
function writeConsoleLine(level, line) {
    clearActiveProgressLine();
    const sanitized = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
        ? line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?").replace(/[\uD800-\uDFFF]/g, "?")
        : line;
    const sink = loggingState.rawConsole ?? console;
    if (loggingState.forceConsoleToStderr || level === "error" || level === "fatal") {
        (sink.error ?? console.error)(sanitized);
    }
    else if (level === "warn") {
        (sink.warn ?? console.warn)(sanitized);
    }
    else {
        (sink.log ?? console.log)(sanitized);
    }
}
function logToFile(fileLogger, level, message, meta) {
    if (level === "silent") {
        return;
    }
    const safeLevel = level;
    const method = fileLogger[safeLevel];
    if (typeof method !== "function") {
        return;
    }
    if (meta && Object.keys(meta).length > 0) {
        method.call(fileLogger, meta, message);
    }
    else {
        method.call(fileLogger, message);
    }
}
export function createSubsystemLogger(subsystem) {
    let fileLogger = null;
    const getFileLogger = () => {
        if (!fileLogger) {
            fileLogger = getChildLogger({ subsystem });
        }
        return fileLogger;
    };
    const emit = (level, message, meta) => {
        const consoleSettings = getConsoleSettings();
        let consoleMessageOverride;
        let fileMeta = meta;
        if (meta && Object.keys(meta).length > 0) {
            const { consoleMessage, ...rest } = meta;
            if (typeof consoleMessage === "string") {
                consoleMessageOverride = consoleMessage;
            }
            fileMeta = Object.keys(rest).length > 0 ? rest : undefined;
        }
        logToFile(getFileLogger(), level, message, fileMeta);
        if (!shouldLogToConsole(level, { level: consoleSettings.level })) {
            return;
        }
        if (!shouldLogSubsystemToConsole(subsystem)) {
            return;
        }
        const consoleMessage = consoleMessageOverride ?? message;
        if (!isVerbose() &&
            subsystem === "agent/embedded" &&
            /(sessionId|runId)=probe-/.test(consoleMessage)) {
            return;
        }
        const line = formatConsoleLine({
            level,
            subsystem,
            message: consoleSettings.style === "json" ? message : consoleMessage,
            style: consoleSettings.style,
            meta: fileMeta,
        });
        writeConsoleLine(level, line);
    };
    const isConsoleEnabled = (level) => {
        const consoleSettings = getConsoleSettings();
        return (shouldLogToConsole(level, { level: consoleSettings.level }) &&
            shouldLogSubsystemToConsole(subsystem));
    };
    const isFileEnabled = (level) => isFileLogLevelEnabled(level);
    const logger = {
        subsystem,
        isEnabled: (level, target = "any") => {
            if (target === "console") {
                return isConsoleEnabled(level);
            }
            if (target === "file") {
                return isFileEnabled(level);
            }
            return isConsoleEnabled(level) || isFileEnabled(level);
        },
        trace: (message, meta) => emit("trace", message, meta),
        debug: (message, meta) => emit("debug", message, meta),
        info: (message, meta) => emit("info", message, meta),
        warn: (message, meta) => emit("warn", message, meta),
        error: (message, meta) => emit("error", message, meta),
        fatal: (message, meta) => emit("fatal", message, meta),
        raw: (message) => {
            logToFile(getFileLogger(), "info", message, { raw: true });
            if (shouldLogSubsystemToConsole(subsystem)) {
                if (!isVerbose() &&
                    subsystem === "agent/embedded" &&
                    /(sessionId|runId)=probe-/.test(message)) {
                    return;
                }
                writeConsoleLine("info", message);
            }
        },
        child: (name) => createSubsystemLogger(`${subsystem}/${name}`),
    };
    return logger;
}
export function runtimeForLogger(logger, exit = defaultRuntime.exit) {
    const formatArgs = (...args) => args
        .map((arg) => formatRuntimeArg(arg))
        .join(" ")
        .trim();
    return {
        log: (...args) => logger.info(formatArgs(...args)),
        error: (...args) => logger.error(formatArgs(...args)),
        exit,
    };
}
export function createSubsystemRuntime(subsystem, exit = defaultRuntime.exit) {
    return runtimeForLogger(createSubsystemLogger(subsystem), exit);
}
