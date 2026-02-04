/**
 * Dedicated memory trace logger.
 *
 * Writes verbose/trace-level memory operations to a **separate** rolling log
 * file (`/tmp/openclaw/memory-YYYY-MM-DD.log`) so the main gateway logs stay
 * compact while still providing full observability into memory persist,
 * retrieval, and flush operations.
 *
 * The gateway's `createSubsystemLogger("memory")` is still used for
 * info/warn/error messages that appear in the main log.  This module adds a
 * parallel trace stream that captures:
 *   - search queries, strategy selection, scoring, result counts
 *   - sync triggers, per-file index/skip decisions, chunk stats
 *   - embedding cache hit/miss ratios
 *   - memory flush threshold calculations and outcomes
 *
 * Gateway-level summary lines reference the memory log path so operators know
 * where to look for detail.
 */

import fs from "node:fs";
import path from "node:path";
import { createSensitiveRedactor, getConfiguredRedactOptions } from "../logging/redact.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

const LOG_DIR = "/tmp/openclaw";
const LOG_PREFIX = "memory";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 48 * 60 * 60 * 1000; // 48h (keep a bit longer than main logs)

// ---------------------------------------------------------------------------
// Rolling log path helpers
// ---------------------------------------------------------------------------

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function memoryLogPathForToday(): string {
  return path.join(LOG_DIR, `${LOG_PREFIX}-${formatLocalDate(new Date())}${LOG_SUFFIX}`);
}

function pruneOldMemoryLogs(): void {
  try {
    const entries = fs.readdirSync(LOG_DIR, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
      const fullPath = path.join(LOG_DIR, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

let currentLogPath: string | null = null;
let pruned = false;

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeMemoryLogLine(record: Record<string, unknown>): void {
  try {
    const today = memoryLogPathForToday();
    if (currentLogPath !== today) {
      ensureLogDir();
      if (!pruned) {
        pruneOldMemoryLogs();
        pruned = true;
      }
      currentLogPath = today;
    }
    const redactor = createSensitiveRedactor(getConfiguredRedactOptions());
    const redacted = redactor.redactValue(record);
    const line = JSON.stringify(redacted);
    fs.appendFileSync(currentLogPath!, `${line}\n`, { encoding: "utf8" });
  } catch {
    // never block on logging failures
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type MemoryTraceLogger = {
  /** Subsystem logger for gateway-visible messages (info/warn/error). */
  gateway: SubsystemLogger;

  /** Path to the current memory trace log file. */
  logFile: () => string;

  /** Trace-level detail (memory log file only). */
  trace: (message: string, meta?: Record<string, unknown>) => void;

  /** Debug-level detail (memory log file + gateway debug). */
  debug: (message: string, meta?: Record<string, unknown>) => void;

  /** Info-level (both memory log file and gateway). */
  info: (message: string, meta?: Record<string, unknown>) => void;

  /** Warn-level (both memory log file and gateway). */
  warn: (message: string, meta?: Record<string, unknown>) => void;

  /** Error-level (both memory log file and gateway). */
  error: (message: string, meta?: Record<string, unknown>) => void;

  /**
   * Emit a gateway-level summary that points operators to the memory log.
   * Use this at the start/end of significant operations (sync, search, flush).
   */
  summary: (message: string, meta?: Record<string, unknown>) => void;

  /** Create a child logger with an appended subsystem prefix. */
  child: (name: string) => MemoryTraceLogger;
};

function buildRecord(
  level: string,
  subsystem: string,
  message: string,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    time: new Date().toISOString(),
    level,
    subsystem,
    message,
    ...meta,
  };
}

export function createMemoryTraceLogger(subsystem = "memory"): MemoryTraceLogger {
  const gateway = createSubsystemLogger(subsystem);

  const logger: MemoryTraceLogger = {
    gateway,
    logFile: () => memoryLogPathForToday(),

    trace: (message, meta) => {
      writeMemoryLogLine(buildRecord("trace", subsystem, message, meta));
      // trace stays out of gateway logs
    },

    debug: (message, meta) => {
      writeMemoryLogLine(buildRecord("debug", subsystem, message, meta));
      gateway.debug(message, meta);
    },

    info: (message, meta) => {
      writeMemoryLogLine(buildRecord("info", subsystem, message, meta));
      gateway.info(message, meta);
    },

    warn: (message, meta) => {
      writeMemoryLogLine(buildRecord("warn", subsystem, message, meta));
      gateway.warn(message, meta);
    },

    error: (message, meta) => {
      writeMemoryLogLine(buildRecord("error", subsystem, message, meta));
      gateway.error(message, meta);
    },

    summary: (message, meta) => {
      const logFile = memoryLogPathForToday();
      gateway.info(message, {
        ...meta,
        consoleMessage: `${message} (details: ${logFile})`,
      });
      writeMemoryLogLine(buildRecord("info", subsystem, message, meta));
    },

    child: (name) => createMemoryTraceLogger(`${subsystem}/${name}`),
  };

  return logger;
}

/** Singleton memory trace logger. */
export const memLog = createMemoryTraceLogger("memory");
