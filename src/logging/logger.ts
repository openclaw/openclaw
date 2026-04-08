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

// Close the log fd synchronously when the process exits. Do not register SIGINT/SIGTERM
// listeners here: Node disables default termination for those signals when listeners exist,
// and we must not swallow Ctrl+C / SIGTERM without exiting.
function setupLogFdCleanup(): void {
  if (logFdCleanupRegistered) {
    return;
  }
  logFdCleanupRegistered = true;

  const cleanup = () => {
    releaseCurrentLogFileFd();
  };

  process.once("exit", cleanup);
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
  if (level === "silent") {
    return false;
  }
  if (settings.level === "silent") {
    return false;
  }
  return levelToMinLevel(level) >= levelToMinLevel(settings.level);
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

  // Each buildLogger call gets its own fd state so stale logger instances cannot
  // corrupt the active logger's fd, byte counter, or rotation decisions.
  let currentFileBytes = getCurrentLogFileBytes(settings.file);
  const fdState: LogFileFd = { fd: null, path: null, lastInodeCheckMs: 0 };
  latestLogFileFd = fdState;
  try {
    fdState.fd = fs.openSync(settings.file, "a");
    fdState.path = settings.file;
  } catch {
    // Will fall back to appendFileSync
  }

  let warnedAboutSizeCap = false;
  // Rotation threshold at 95% of maxFileBytes to avoid hitting the cap exactly
  const rotationThreshold = settings.maxFileBytes * 0.95;
  // Debounce pruning so it runs at most once per hour across rotations in long-lived processes.
  let lastPruneMs = 0;
  const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

  // Attempt rotation; returns true on success and resets byte counters + warn flag.
  // On failure (e.g. EXDEV) leaves state unchanged so the size cap fires normally.
  const maybeRotate = (): boolean => {
    const rotated = rotateLogFile(settings.file, fdState);
    if (rotated === settings.file) {
      return false;
    }
    currentFileBytes = 0;
    warnedAboutSizeCap = false;
    // Prune stale rotated segments in long-lived processes; debounced to at most once/hour.
    const now = Date.now();
    if (now - lastPruneMs >= PRUNE_INTERVAL_MS) {
      lastPruneMs = now;
      pruneOldRollingLogs(path.dirname(settings.file));
    }
    return true;
  };

  logger.attachTransport((logObj: LogObj) => {
    try {
      // Reopen the fd if the file was deleted or externally rotated since the last check.
      // Must happen before pendingBytes is read so the byte counter stays accurate.
      if (checkAndReopenFd(settings.file, fdState)) {
        currentFileBytes = getCurrentLogFileBytes(settings.file);
      }

      const time = formatTimestamp(logObj.date ?? new Date(), { style: "long" });
      const line = JSON.stringify({ ...logObj, time });
      const payload = `${line}\n`;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      let pendingBytes = currentFileBytes;

      // Rotate before hitting the hard cap (rolling logs only): keeps writes flowing when the
      // current file cannot fit this line. Skip rotation when a single entry alone exceeds
      // maxFileBytes — otherwise every suppressed write would rename to .N and pile up segments.
      if (
        isRollingPath(settings.file) &&
        pendingBytes + payloadBytes > settings.maxFileBytes &&
        payloadBytes <= settings.maxFileBytes
      ) {
        if (maybeRotate()) {
          pendingBytes = 0;
        }
      }

      // Proactive rotation once the file is near capacity so the next lines land in a fresh file.
      if (isRollingPath(settings.file) && pendingBytes > rotationThreshold) {
        if (maybeRotate()) {
          pendingBytes = 0;
        }
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
          appendLogLine(settings.file, `${warningLine}\n`, fdState);
          process.stderr.write(
            `[openclaw] log file size cap reached; suppressing writes file=${settings.file} maxFileBytes=${settings.maxFileBytes}\n`,
          );
        }
        return;
      }

      if (appendLogLine(settings.file, payload, fdState)) {
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

// Per-logger-instance file descriptor state. Each buildLogger call owns one LogFileFd so
// that stale logger instances can never read or mutate the active logger's fd or byte counters.
type LogFileFd = { fd: number | null; path: string | null; lastInodeCheckMs: number };

// Points to the fd state of the most recently built logger; used only by
// releaseCurrentLogFileFd (called from setLoggerOverride / resetLogger / process-exit cleanup).
// Stale loggers hold their own LogFileFd references and must not touch this pointer.
let latestLogFileFd: LogFileFd = { fd: null, path: null, lastInodeCheckMs: 0 };

function releaseLogFileFd(state: LogFileFd): void {
  if (state.fd !== null) {
    try {
      fs.closeSync(state.fd);
    } catch {
      // Ignore errors during release
    }
    state.fd = null;
  }
  state.path = null;
  state.lastInodeCheckMs = 0;
}

function releaseCurrentLogFileFd(): void {
  releaseLogFileFd(latestLogFileFd);
}

// How often to verify the open fd still points to the same inode as the path.
// Catches external deletions and logrotate-style renames between checks.
const INODE_CHECK_INTERVAL_MS = 5_000;

/**
 * Verify that the fd in fdState still refers to the same inode as `file`.
 * If the file was deleted or externally rotated the fd is released and reopened
 * to the current path.  Returns true when a reopen occurred so the caller can
 * re-read currentFileBytes.
 */
function checkAndReopenFd(file: string, fdState: LogFileFd): boolean {
  if (fdState.fd === null || file !== fdState.path) {
    return false;
  }
  const now = Date.now();
  if (now - fdState.lastInodeCheckMs < INODE_CHECK_INTERVAL_MS) {
    return false;
  }
  fdState.lastInodeCheckMs = now;

  let pathIno: number | null = null;
  try {
    pathIno = fs.statSync(file).ino;
  } catch {
    // path gone or inaccessible
  }
  let fdIno: number | null = null;
  try {
    fdIno = fs.fstatSync(fdState.fd).ino;
  } catch {
    // fd invalid
  }

  if (pathIno !== null && fdIno !== null && pathIno === fdIno) {
    return false; // same inode — no reopen needed
  }

  // Inode mismatch or path/fd inaccessible: reopen to the current path.
  releaseLogFileFd(fdState);
  try {
    fdState.fd = fs.openSync(file, "a");
    fdState.path = file;
    fdState.lastInodeCheckMs = Date.now();
  } catch {
    // reopen failed; subsequent writes fall back to appendFileSync
  }
  return true;
}

/**
 * Rotate the current log file by renaming it with a numeric suffix and creating a new file.
 * Returns the path to the rotated file.
 * Time complexity: O(1) - rename is metadata-only, independent of file size.
 */
function rotateLogFile(basePath: string, fdState: LogFileFd): string {
  const ownsFd = fdState.fd !== null && fdState.path !== null && basePath === fdState.path;

  if (ownsFd) {
    releaseLogFileFd(fdState);
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

  if (ownsFd) {
    try {
      fdState.fd = fs.openSync(basePath, "a");
      fdState.path = basePath;
    } catch {
      // fall back to appendFileSync
    }
  }
  return rotatedPath;
}

function appendLogLine(file: string, line: string, fdState: LogFileFd): boolean {
  try {
    if (fdState.fd !== null && file === fdState.path) {
      // writeSync may write fewer bytes than requested (e.g. low-disk, interrupted write).
      // Loop until all bytes land or a zero-progress write signals a permanent stall.
      const buf = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buf.byteLength) {
        const written = fs.writeSync(fdState.fd, buf, offset, buf.byteLength - offset);
        if (written === 0) {
          return false;
        }
        offset += written;
      }
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
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : base.settings.minLevel;
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
        minLevel: logger.settings.minLevel,
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
