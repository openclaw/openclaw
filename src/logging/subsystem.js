import { Chalk } from "chalk";
import { normalizeChatChannelId } from "../channels/ids.js";
import { isVerbose } from "../global-state.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { formatConsoleTimestamp, getConsoleSettings, shouldLogSubsystemToConsole, } from "./console.js";
import { levelToMinLevel } from "./levels.js";
import { getChildLogger, isFileLogLevelEnabled } from "./logger.js";
import { loggingState } from "./state.js";
function normalizeSubsystemLabel(subsystem) {
    if (typeof subsystem !== "string") {
        return "unknown";
    }
    const normalized = subsystem.trim();
    return normalized.length > 0 ? normalized : "unknown";
}
function shouldLogToConsole(level, settings) {
    if (level === "silent") {
        return false;
    }
    if (settings.level === "silent") {
        return false;
    }
    const current = levelToMinLevel(level);
    const min = levelToMinLevel(settings.level);
    return current >= min;
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
    const term = normalizeLowercaseStringOrEmpty(process.env.TERM);
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
    const hasTty = process.stdout.isTTY || process.stderr.isTTY;
    return hasTty || isRichConsoleEnv() ? new Chalk({ level: 1 }) : new Chalk({ level: 0 });
}
const SUBSYSTEM_COLORS = ["cyan", "green", "yellow", "blue", "magenta", "red"];
const SUBSYSTEM_COLOR_OVERRIDES = {
    "gmail-watcher": "blue",
};
const SUBSYSTEM_PREFIXES_TO_DROP = ["gateway", "channels", "providers"];
const SUBSYSTEM_MAX_SEGMENTS = 2;
function isChannelSubsystemPrefix(value) {
    const normalized = normalizeLowercaseStringOrEmpty(value);
    if (!normalized) {
        return false;
    }
    return normalizeChatChannelId(normalized) === normalized || normalized === "webchat";
}
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
    if (isChannelSubsystemPrefix(parts[0])) {
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
    // Common duplication when a message manually includes the subsystem tag.
    if (message.startsWith("[")) {
        const closeIdx = message.indexOf("]");
        if (closeIdx > 1) {
            const bracketTag = message.slice(1, closeIdx);
            if (normalizeLowercaseStringOrEmpty(bracketTag) ===
                normalizeLowercaseStringOrEmpty(displaySubsystem)) {
                let i = closeIdx + 1;
                while (message[i] === " ") {
                    i += 1;
                }
                return message.slice(i);
            }
        }
    }
    const prefix = message.slice(0, displaySubsystem.length);
    if (normalizeLowercaseStringOrEmpty(prefix) !== normalizeLowercaseStringOrEmpty(displaySubsystem)) {
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
            time: formatConsoleTimestamp("json"),
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
            return color.gray(formatConsoleTimestamp("pretty"));
        }
        if (loggingState.consoleTimestampPrefix) {
            return color.gray(formatConsoleTimestamp(opts.style));
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
function shouldSuppressProbeConsoleLine(params) {
    if (isVerbose()) {
        return false;
    }
    if (params.level === "error" || params.level === "fatal") {
        return false;
    }
    const subsystem = normalizeSubsystemLabel(params.subsystem);
    const message = typeof params.message === "string" ? params.message : "";
    const isProbeSuppressedSubsystem = subsystem === "agent/embedded" ||
        subsystem.startsWith("agent/embedded/") ||
        subsystem === "model-fallback" ||
        subsystem.startsWith("model-fallback/");
    if (!isProbeSuppressedSubsystem) {
        return false;
    }
    const runLikeId = typeof params.meta?.runId === "string"
        ? params.meta.runId
        : typeof params.meta?.sessionId === "string"
            ? params.meta.sessionId
            : undefined;
    if (runLikeId?.startsWith("probe-")) {
        return true;
    }
    return /(sessionId|runId)=probe-/.test(message);
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
    const resolvedSubsystem = normalizeSubsystemLabel(subsystem);
    let fileLogger = null;
    const emitLog = (level, message, meta) => {
        const consoleSettings = getConsoleSettings();
        const consoleEnabled = shouldLogToConsole(level, { level: consoleSettings.level }) &&
            shouldLogSubsystemToConsole(resolvedSubsystem);
        const fileEnabled = isFileLogLevelEnabled(level);
        if (!consoleEnabled && !fileEnabled) {
            return;
        }
        let consoleMessageOverride;
        let fileMeta = meta;
        if (meta && Object.keys(meta).length > 0) {
            const { consoleMessage, ...rest } = meta;
            if (typeof consoleMessage === "string") {
                consoleMessageOverride = consoleMessage;
            }
            fileMeta = Object.keys(rest).length > 0 ? rest : undefined;
        }
        if (fileEnabled) {
            if (!fileLogger) {
                fileLogger = getChildLogger({ subsystem: resolvedSubsystem });
            }
            logToFile(fileLogger, level, message, fileMeta);
        }
        if (!consoleEnabled) {
            return;
        }
        const consoleMessage = consoleMessageOverride ?? message;
        if (shouldSuppressProbeConsoleLine({
            level,
            subsystem: resolvedSubsystem,
            message: consoleMessage,
            meta: fileMeta,
        })) {
            return;
        }
        writeConsoleLine(level, formatConsoleLine({
            level,
            subsystem: resolvedSubsystem,
            message: consoleSettings.style === "json" ? message : consoleMessage,
            style: consoleSettings.style,
            meta: fileMeta,
        }));
    };
    const logger = {
        subsystem: resolvedSubsystem,
        isEnabled(level, target = "any") {
            const isConsoleEnabled = shouldLogToConsole(level, { level: getConsoleSettings().level }) &&
                shouldLogSubsystemToConsole(resolvedSubsystem);
            const isFileEnabled = isFileLogLevelEnabled(level);
            if (target === "console") {
                return isConsoleEnabled;
            }
            if (target === "file") {
                return isFileEnabled;
            }
            return isConsoleEnabled || isFileEnabled;
        },
        trace(message, meta) {
            emitLog("trace", message, meta);
        },
        debug(message, meta) {
            emitLog("debug", message, meta);
        },
        info(message, meta) {
            emitLog("info", message, meta);
        },
        warn(message, meta) {
            emitLog("warn", message, meta);
        },
        error(message, meta) {
            emitLog("error", message, meta);
        },
        fatal(message, meta) {
            emitLog("fatal", message, meta);
        },
        raw(message) {
            if (isFileLogLevelEnabled("info")) {
                if (!fileLogger) {
                    fileLogger = getChildLogger({ subsystem: resolvedSubsystem });
                }
                logToFile(fileLogger, "info", message, { raw: true });
            }
            if (shouldLogToConsole("info", { level: getConsoleSettings().level }) &&
                shouldLogSubsystemToConsole(resolvedSubsystem)) {
                if (shouldSuppressProbeConsoleLine({
                    level: "info",
                    subsystem: resolvedSubsystem,
                    message,
                })) {
                    return;
                }
                writeConsoleLine("info", message);
            }
        },
        child(name) {
            return createSubsystemLogger(`${resolvedSubsystem}/${name}`);
        },
    };
    return logger;
}
export function runtimeForLogger(logger, exit = defaultRuntime.exit) {
    return {
        log(...args) {
            logger.info(args
                .map((arg) => formatRuntimeArg(arg))
                .join(" ")
                .trim());
        },
        error(...args) {
            logger.error(args
                .map((arg) => formatRuntimeArg(arg))
                .join(" ")
                .trim());
        },
        writeStdout(value) {
            logger.info(value);
        },
        writeJson(value, space = 2) {
            logger.info(JSON.stringify(value, null, space > 0 ? space : undefined));
        },
        exit,
    };
}
export function createSubsystemRuntime(subsystem, exit = defaultRuntime.exit) {
    return runtimeForLogger(createSubsystemLogger(subsystem), exit);
}
