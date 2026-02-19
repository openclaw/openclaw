import util from "node:util";
import type { OpenClawConfig } from "../config/types.js";
import { isVerbose } from "../globals.js";
import { stripAnsi } from "../terminal/ansi.js";
import { readLoggingConfig } from "./config.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger, type LoggerSettings } from "./logger.js";
import { loggingState } from "./state.js";
import { formatLocalIsoWithOffset } from "./timestamps.js";

export type ConsoleStyle = "pretty" | "compact" | "json";
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

function resolveNodeRequire(): ((id: string) => NodeJS.Require) | null {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return null;
  }
  try {
    const moduleNamespace = getBuiltinModule("module") as {
      createRequire?: (id: string) => NodeJS.Require;
    };
    return typeof moduleNamespace.createRequire === "function"
      ? moduleNamespace.createRequire
      : null;
  } catch {
    return null;
  }
}

const requireConfig = resolveNodeRequire()?.(import.meta.url) ?? null;
type ConsoleConfigLoader = () => OpenClawConfig["logging"] | undefined;
const loadConfigFallbackDefault: ConsoleConfigLoader = () => {
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    return loaded?.loadConfig?.().logging;
  } catch {
    return undefined;
  }
};
let loadConfigFallback: ConsoleConfigLoader = loadConfigFallbackDefault;

export function setConsoleConfigLoaderForTests(loader?: ConsoleConfigLoader): void {
  loadConfigFallback = loader ?? loadConfigFallbackDefault;
}

function normalizeConsoleLevel(level?: string): LogLevel {
  if (isVerbose()) {
    return "debug";
  }
  if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") {
    return "silent";
  }
  return normalizeLogLevel(level, "info");
}

function normalizeConsoleStyle(style?: string): ConsoleStyle {
  if (style === "compact" || style === "json" || style === "pretty") {
    return style;
  }
  if (!process.stdout.isTTY) {
    return "compact";
  }
  return "pretty";
}

function resolveConsoleSettings(): ConsoleSettings {
  let cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg) {
    if (loggingState.resolvingConsoleSettings) {
      cfg = undefined;
    } else {
      loggingState.resolvingConsoleSettings = true;
      try {
        cfg = loadConfigFallback();
      } finally {
        loggingState.resolvingConsoleSettings = false;
      }
    }
  }
  const level = normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}

function consoleSettingsChanged(a: ConsoleSettings | null, b: ConsoleSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.style !== b.style;
}

export function getConsoleSettings(): ConsoleLoggerSettings {
  const settings = resolveConsoleSettings();
  const cached = loggingState.cachedConsoleSettings as ConsoleSettings | null;
  if (!cached || consoleSettingsChanged(cached, settings)) {
    loggingState.cachedConsoleSettings = settings;
  }
  return loggingState.cachedConsoleSettings as ConsoleSettings;
}

export function getResolvedConsoleSettings(): ConsoleLoggerSettings {
  return getConsoleSettings();
}

// Route all console output (including tslog console writes) to stderr.
// This keeps stdout clean for RPC/JSON modes.
export function routeLogsToStderr(): void {
  loggingState.forceConsoleToStderr = true;
}

export function setConsoleSubsystemFilter(filters?: string[] | null): void {
  if (!filters || filters.length === 0) {
    loggingState.consoleSubsystemFilter = null;
    return;
  }
  const normalized = filters.map((value) => value.trim()).filter((value) => value.length > 0);
  loggingState.consoleSubsystemFilter = normalized.length > 0 ? normalized : null;
}

export function setConsoleTimestampPrefix(enabled: boolean): void {
  loggingState.consoleTimestampPrefix = enabled;
}

export function shouldLogSubsystemToConsole(subsystem: string): boolean {
  const filter = loggingState.consoleSubsystemFilter;
  if (!filter || filter.length === 0) {
    return true;
  }
  return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}

const SUPPRESSED_CONSOLE_PREFIXES = [
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
] as const;

function shouldSuppressConsoleMessage(message: string): boolean {
  if (isVerbose()) {
    return false;
  }
  if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return true;
  }
  if (
    message.startsWith("[EventQueue] Slow listener detected") &&
    message.includes("DiscordMessageListener")
  ) {
    return true;
  }
  return false;
}

function isEpipeError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

export function formatConsoleTimestamp(style: ConsoleStyle): string {
  const now = new Date();
  if (style === "pretty") {
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
  return formatLocalIsoWithOffset(now);
}

function hasTimestampPrefix(value: string): boolean {
  return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(
    value,
  );
}

function isJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route console.* calls through file logging while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
export function enableConsoleCapture(): void {
  if (loggingState.consolePatched) {
    return;
  }
  loggingState.consolePatched = true;

  // Handle async EPIPE errors on stdout/stderr. The synchronous try/catch in
  // the forward() wrapper below only covers errors thrown during write dispatch.
  // When the receiving pipe closes (e.g. during shutdown), Node emits the error
  // asynchronously on the stream. Without a listener this becomes an uncaught
  // exception that crashes the gateway.
  // Guard separately from consolePatched so test resets don't stack listeners.
  if (!loggingState.streamErrorHandlersInstalled) {
    loggingState.streamErrorHandlersInstalled = true;
    for (const stream of [process.stdout, process.stderr]) {
      stream.on("error", (err) => {
        if (isEpipeError(err)) {
          return;
        }
        throw err;
      });
    }
  }

  let logger: ReturnType<typeof getLogger> | null = null;
  const getLoggerLazy = () => {
    if (!logger) {
      logger = getLogger();
    }
    return logger;
  };

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  loggingState.rawConsole = {
    log: original.log,
    info: original.info,
    warn: original.warn,
    error: original.error,
  };

  const forward =
    (level: LogLevel, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = util.format(...args);
      if (shouldSuppressConsoleMessage(formatted)) {
        return;
      }
      const trimmed = stripAnsi(formatted).trimStart();
      const shouldPrefixTimestamp =
        loggingState.consoleTimestampPrefix &&
        trimmed.length > 0 &&
        !hasTimestampPrefix(trimmed) &&
        !isJsonPayload(trimmed);
      const timestamp = shouldPrefixTimestamp
        ? formatConsoleTimestamp(getConsoleSettings().style)
        : "";
      try {
        const resolvedLogger = getLoggerLazy();
        // Map console levels to file logger
        if (level === "trace") {
          resolvedLogger.trace(formatted);
        } else if (level === "debug") {
          resolvedLogger.debug(formatted);
        } else if (level === "info") {
          resolvedLogger.info(formatted);
        } else if (level === "warn") {
          resolvedLogger.warn(formatted);
        } else if (level === "error" || level === "fatal") {
          resolvedLogger.error(formatted);
        } else {
          resolvedLogger.info(formatted);
        }
      } catch {
        // never block console output on logging failures
      }
      if (loggingState.forceConsoleToStderr) {
        // in RPC/JSON mode, keep stdout clean
        try {
          const line = timestamp ? `${timestamp} ${formatted}` : formatted;
          process.stderr.write(`${line}\n`);
        } catch (err) {
          if (isEpipeError(err)) {
            return;
          }
          throw err;
        }
      } else {
        try {
          if (!timestamp) {
            orig.apply(console, args as []);
            return;
          }
          if (args.length === 0) {
            orig.call(console, timestamp);
            return;
          }
          if (typeof args[0] === "string") {
            orig.call(console, `${timestamp} ${args[0]}`, ...args.slice(1));
            return;
          }
          orig.call(console, timestamp, ...args);
        } catch (err) {
          if (isEpipeError(err)) {
            return;
          }
          throw err;
        }
      }
    };

  console.log = forward("info", original.log);
  console.info = forward("info", original.info);
  console.warn = forward("warn", original.warn);
  console.error = forward("error", original.error);
  console.debug = forward("debug", original.debug);
  console.trace = forward("trace", original.trace);
}
