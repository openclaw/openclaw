import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

import pino, { type Bindings, type LevelWithSilent, type Logger } from "pino";
import { loadConfig, type WarelayConfig } from "./config/config.js";
import { isVerbose } from "./globals.js";

export const DEFAULT_LOG_DIR = path.join(os.tmpdir(), "clawdis");
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "clawdis.log"); // legacy single-file path

const LOG_PREFIX = "clawdis";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const ALLOWED_LEVELS: readonly LevelWithSilent[] = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

export type LoggerSettings = {
  level?: LevelWithSilent;
  file?: string;
};

type ResolvedSettings = {
  level: LevelWithSilent;
  file: string;
};
export type LoggerResolvedSettings = ResolvedSettings;

let cachedLogger: Logger | null = null;
let cachedSettings: ResolvedSettings | null = null;
let overrideSettings: LoggerSettings | null = null;
let consolePatched = false;

function normalizeLevel(level?: string): LevelWithSilent {
  if (isVerbose()) return "trace";
  const candidate = level ?? "info";
  return ALLOWED_LEVELS.includes(candidate as LevelWithSilent)
    ? (candidate as LevelWithSilent)
    : "info";
}

function resolveSettings(): ResolvedSettings {
  const cfg: WarelayConfig["logging"] | undefined =
    overrideSettings ?? loadConfig().logging;
  const level = normalizeLevel(cfg?.level);
  const file = cfg?.file ?? defaultRollingPathForToday();
  return { level, file };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) return true;
  return a.level !== b.level || a.file !== b.file;
}

function buildLogger(settings: ResolvedSettings): Logger {
  fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (isRollingPath(settings.file)) {
    pruneOldRollingLogs(path.dirname(settings.file));
  }
  const destination = pino.destination({
    dest: settings.file,
    mkdir: true,
    sync: true, // deterministic for tests; log volume is modest.
  });
  return pino(
    {
      level: settings.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export function getLogger(): Logger {
  const settings = resolveSettings();
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    cachedLogger = buildLogger(settings);
    cachedSettings = settings;
  }
  return cachedLogger;
}

export function getChildLogger(
  bindings?: Bindings,
  opts?: { level?: LevelWithSilent },
): Logger {
  return getLogger().child(bindings ?? {}, opts);
}

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
    (level: LevelWithSilent, orig: (...args: unknown[]) => void) =>
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
      orig.apply(console, args as []);
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
