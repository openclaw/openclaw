import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { Logger as TsLogger } from "tslog";
import { loadConfig, type ClawdisConfig } from "./config/config.js";
import { isVerbose } from "./globals.js";

// Pin to /tmp so mac Debug UI and docs match; os.tmpdir() can be a per-user
// randomized path on macOS which made the “Open log” button a no-op.
export const DEFAULT_LOG_DIR = "/tmp/clawdis";
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "clawdis.log"); // legacy single-file path

const LOG_PREFIX = "clawdis";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const ALLOWED_LEVELS = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

type Level = (typeof ALLOWED_LEVELS)[number];

export type LoggerSettings = {
  level?: Level;
  file?: string;
};

type LogObj = { date?: Date } & Record<string, unknown>;

type ResolvedSettings = {
  level: Level;
  file: string;
};
export type LoggerResolvedSettings = ResolvedSettings;

let cachedLogger: TsLogger<LogObj> | null = null;
let cachedSettings: ResolvedSettings | null = null;
let overrideSettings: LoggerSettings | null = null;
let consolePatched = false;
let forceConsoleToStderr = false;

function normalizeLevel(level?: string): Level {
  if (isVerbose()) return "trace";
  const candidate = level ?? "info";
  return ALLOWED_LEVELS.includes(candidate as Level)
    ? (candidate as Level)
    : "info";
}

function resolveSettings(): ResolvedSettings {
  const cfg: ClawdisConfig["logging"] | undefined =
    overrideSettings ?? loadConfig().logging;
  const level = normalizeLevel(cfg?.level);
  const file = cfg?.file ?? defaultRollingPathForToday();
  return { level, file };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) return true;
  return a.level !== b.level || a.file !== b.file;
}

function levelToMinLevel(level: Level): number {
  // tslog level ordering: fatal=0, error=1, warn=2, info=3, debug=4, trace=5
  const map: Record<Level, number> = {
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

function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (isRollingPath(settings.file)) {
    pruneOldRollingLogs(path.dirname(settings.file));
  }
  const logger = new TsLogger<LogObj>({
    name: "clawdis",
    minLevel: levelToMinLevel(settings.level),
    type: "hidden", // no ansi formatting
  });

  logger.attachTransport((logObj: LogObj) => {
    try {
      const time = logObj.date?.toISOString?.() ?? new Date().toISOString();
      const line = JSON.stringify({ ...logObj, time });
      fs.appendFileSync(settings.file, `${line}\n`, { encoding: "utf8" });
    } catch {
      // never block on logging failures
    }
  });

  return logger;
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    cachedLogger = buildLogger(settings);
    cachedSettings = settings;
  }
  return cachedLogger;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: Level },
): TsLogger<LogObj> {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : undefined;
  const name = bindings ? JSON.stringify(bindings) : undefined;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}

export type LogLevel = Level;

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(
  logger: TsLogger<LogObj>,
  level: Level,
): PinoLikeLogger {
  const buildChild = (bindings?: Record<string, unknown>) =>
    toPinoLikeLogger(
      logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
      }),
      level,
    );

  return {
    level,
    child: buildChild,
    trace: (...args: unknown[]) => logger.trace(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    fatal: (...args: unknown[]) => logger.fatal(...args),
  };
}

export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
}

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
  overrideSettings = settings;
  cachedLogger = null;
  cachedSettings = null;
}

export function resetLogger() {
  cachedLogger = null;
  cachedSettings = null;
  overrideSettings = null;
}

// Route all console output (including tslog console writes) to stderr.
// This keeps stdout clean for RPC/JSON modes.
export function routeLogsToStderr(): void {
  forceConsoleToStderr = true;
}

/**
 * Route console.* calls through pino while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
export function enableConsoleCapture(): void {
  if (consolePatched) return;
  consolePatched = true;

  const logger = getLogger();

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };

  const forward =
    (level: Level, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = util.format(...args);
      try {
        // Map console levels to pino
        if (level === "trace") {
          logger.trace(formatted);
        } else if (level === "debug") {
          logger.debug(formatted);
        } else if (level === "info") {
          logger.info(formatted);
        } else if (level === "warn") {
          logger.warn(formatted);
        } else if (level === "error" || level === "fatal") {
          logger.error(formatted);
        } else {
          logger.info(formatted);
        }
      } catch {
        // never block console output on logging failures
      }
      if (forceConsoleToStderr) {
        const target =
          level === "error" || level === "fatal" || level === "warn"
            ? process.stderr
            : process.stderr; // in RPC/JSON mode, keep stdout clean
        target.write(`${formatted}\n`);
      } else {
        orig.apply(console, args as []);
      }
    };

  console.log = forward("info", original.log);
  console.info = forward("info", original.info);
  console.warn = forward("warn", original.warn);
  console.error = forward("error", original.error);
  console.debug = forward("debug", original.debug);
  console.trace = forward("trace", original.trace);
}

function defaultRollingPathForToday(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        !entry.name.startsWith(`${LOG_PREFIX}-`) ||
        !entry.name.endsWith(LOG_SUFFIX)
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore errors during pruning
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}
