import fs from "node:fs";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import type { OpenClawConfig } from "../config/types.js";
import {
  POSIX_OPENCLAW_TMP_DIR,
  resolvePreferredOpenClawTmpDir,
} from "../infra/tmp-openclaw-dir.js";
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import type { ConsoleStyle } from "./console.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";

type ProcessWithBuiltinModule = NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
};

function canUseNodeFs(): boolean {
  const getBuiltinModule = (process as ProcessWithBuiltinModule).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return false;
  }
  try {
    return getBuiltinModule("fs") !== undefined;
  } catch {
    return false;
  }
}

let logFdCleanupRegistered = false;

// Cleanup handler: close file descriptor on graceful exit
function setupLogFdCleanup(): void {
  if (logFdCleanupRegistered) {
    return;
  }
  logFdCleanupRegistered = true;

  const cleanup = () => {
    releaseCurrentLogFileFd();
  };

  process.once("beforeExit", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}

function resolveDefaultLogDir(): string {
  return canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
}

function resolveDefaultLogFile(defaultLogDir: string): string {
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

export type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  maxFileBytes?: number;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
};

type LogObj = { date?: Date } & Record<string, unknown>;

type ResolvedSettings = {
  level: LogLevel;
  file: string;
  maxFileBytes: number;
};
export type LoggerResolvedSettings = ResolvedSettings;
export type LogTransportRecord = Record<string, unknown>;
export type LogTransport = (logObj: LogTransportRecord) => void;

const externalTransports = new Set<LogTransport>();

function attachExternalTransport(logger: TsLogger<LogObj>, transport: LogTransport): void {
  logger.attachTransport((logObj: LogObj) => {
    if (!externalTransports.has(transport)) {
      return;
    }
    try {
      transport(logObj as LogTransportRecord);
    } catch {
      // never block on logging failures
    }
  });
}

function canUseSilentVitestFileLogFastPath(envLevel: LogLevel | undefined): boolean {
  return (
    process.env.VITEST === "true" &&
    process.env.OPENCLAW_TEST_FILE_LOG !== "1" &&
    !envLevel &&
    !loggingState.overrideSettings
  );
}

function resolveSettings(): ResolvedSettings {
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

  let cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg && !shouldSkipMutatingLoggingConfigRead()) {
    try {
      const loaded = requireConfig?.("../config/config.js") as
        | {
            loadConfig?: () => OpenClawConfig;
          }
        | undefined;
      cfg = loaded?.loadConfig?.().logging;
    } catch {
      cfg = undefined;
    }
  }
  const defaultLevel =
    process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
  const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
  const level = envLevel ?? fromConfig;
  const file = cfg?.file ?? defaultRollingPathForToday();
  const maxFileBytes = resolveMaxLogFileBytes(cfg?.maxFileBytes);
  return { level, file, maxFileBytes };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}

export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = (loggingState.cachedSettings as ResolvedSettings | null) ?? resolveSettings();
  if (!loggingState.cachedSettings) {
    loggingState.cachedSettings = settings;
  }
  if (settings.level === "silent") {
    return false;
  }
  return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}

function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  releaseCurrentLogFileFd();

  const logger = new TsLogger<LogObj>({
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

  // Open file descriptor for efficient writes and proper rotation handling
  let currentFileBytes = getCurrentLogFileBytes(settings.file);
  try {
    currentLogFileFd = fs.openSync(settings.file, "a");
    currentLogFilePath = settings.file;
  } catch {
    currentLogFileFd = null;
    currentLogFilePath = null; // Will fall back to appendFileSync
  }

  let warnedAboutSizeCap = false;
  // Rotation threshold at 95% of maxFileBytes to avoid hitting the cap exactly
  const rotationThreshold = settings.maxFileBytes * 0.95;

  logger.attachTransport((logObj: LogObj) => {
    try {
      const time = formatTimestamp(logObj.date ?? new Date(), { style: "long" });
      const line = JSON.stringify({ ...logObj, time });
      const payload = `${line}\n`;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      let pendingBytes = currentFileBytes;

      // Rotate before hitting the hard cap (rolling logs only): keeps writes flowing when the
      // current file cannot fit this line.
      if (isRollingPath(settings.file) && pendingBytes + payloadBytes > settings.maxFileBytes) {
        rotateLogFile(settings.file);
        pendingBytes = 0;
        warnedAboutSizeCap = false;
      }

      // Proactive rotation once the file is near capacity so the next lines land in a fresh file.
      if (isRollingPath(settings.file) && pendingBytes > rotationThreshold) {
        rotateLogFile(settings.file);
        pendingBytes = 0;
        warnedAboutSizeCap = false;
      }

      const nextBytes = pendingBytes + payloadBytes;
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
          process.stderr.write(
            `[openclaw] log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}\n`,
          );
        }
        return;
      }

      if (appendLogLine(settings.file, payload)) {
        currentFileBytes = nextBytes;
      }
    } catch {
      // never block on logging failures
    }
  });
  for (const transport of externalTransports) {
    attachExternalTransport(logger, transport);
  }

  // Set up cleanup handler for file descriptor on process exit
  setupLogFdCleanup();

  return logger;
}

function resolveMaxLogFileBytes(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_LOG_FILE_BYTES;
}

function getCurrentLogFileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// File descriptor for the log file opened by the most recently built file logger only.
// Long-lived logger instances may outlive a rebuild; their transports must not write through
// this FD unless the path matches (see appendLogLine / rotateLogFile).
let currentLogFileFd: number | null = null;
let currentLogFilePath: string | null = null;

function releaseCurrentLogFileFd(): void {
  if (currentLogFileFd !== null) {
    try {
      fs.closeSync(currentLogFileFd);
    } catch {
      // Ignore errors during release
    }
    currentLogFileFd = null;
  }
  currentLogFilePath = null;
}

/**
 * Rotate the current log file by renaming it with a numeric suffix and creating a new file.
 * Returns the path to the rotated file.
 * Time complexity: O(1) - rename is metadata-only, independent of file size.
 */
function rotateLogFile(basePath: string): string {
  const ownsGlobalFd =
    currentLogFileFd !== null && currentLogFilePath !== null && basePath === currentLogFilePath;

  if (ownsGlobalFd) {
    releaseCurrentLogFileFd();
  }

  // Find the next rotation number
  let num = 1;
  while (fs.existsSync(`${basePath}.${num}`)) {
    num++;
  }

  const rotatedPath = `${basePath}.${num}`;

  // Rename current file to .N (O(1) - metadata only)
  try {
    fs.renameSync(basePath, rotatedPath);
  } catch {
    // If rename fails, return original path and let logging continue
    // This handles edge cases like cross-filesystem renames
    return basePath;
  }

  if (ownsGlobalFd) {
    try {
      currentLogFileFd = fs.openSync(basePath, "a");
      currentLogFilePath = basePath;
    } catch {
      currentLogFileFd = null;
      currentLogFilePath = null;
    }
  }
  return rotatedPath;
}

function appendLogLine(file: string, line: string): boolean {
  try {
    if (currentLogFileFd !== null && file === currentLogFilePath) {
      fs.writeSync(currentLogFileFd, line);
      return true;
    }
    fs.appendFileSync(file, line, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  const cachedSettings = loggingState.cachedSettings as ResolvedSettings | null;
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger as TsLogger<LogObj>;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: LogLevel },
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

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger {
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
  loggingState.overrideSettings = settings;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  releaseCurrentLogFileFd();
}

export function resetLogger() {
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  loggingState.overrideSettings = null;
  releaseCurrentLogFileFd();
}

export function registerLogTransport(transport: LogTransport): () => void {
  externalTransports.add(transport);
  const logger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  if (logger) {
    attachExternalTransport(logger, transport);
  }
  return () => {
    externalTransports.delete(transport);
  };
}

export const __test__ = {
  shouldSkipMutatingLoggingConfigRead,
};

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRollingPathForToday(): string {
  const today = formatLocalDate(new Date());
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

/** Matches `openclaw-YYYY-MM-DD.log` and size-rotated siblings `openclaw-YYYY-MM-DD.log.N`. */
const PRUNABLE_ROLLING_LOG_NAME = /^\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/;

function isPrunableRollingLogFileName(name: string): boolean {
  if (!name.startsWith(`${LOG_PREFIX}-`)) {
    return false;
  }
  return PRUNABLE_ROLLING_LOG_NAME.test(name.slice(LOG_PREFIX.length + 1));
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!isPrunableRollingLogFileName(entry.name)) {
        continue;
      }
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
