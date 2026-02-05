/**
 * Dedicated memory trace logger.
 *
 * All memory trace/debug output routes through the gateway's subsystem logger.
 * The gateway's `createSubsystemLogger("memory")` is used for all levels.
 *
 * Previously this module wrote verbose memory operations to a rolling log file
 * under `/tmp/openclaw/`. That file-based logging has been removed in favour of
 * the gateway debug channel, which provides the same observability without
 * filesystem side-effects.
 */

import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type MemoryTraceLogger = {
  /** Subsystem logger for gateway-visible messages (info/warn/error). */
  gateway: SubsystemLogger;

  /** Path to the current memory trace log file (deprecated — always undefined). */
  logFile: () => string | undefined;

  /** Trace-level detail (gateway debug). */
  trace: (message: string, meta?: Record<string, unknown>) => void;

  /** Debug-level detail (gateway debug). */
  debug: (message: string, meta?: Record<string, unknown>) => void;

  /** Info-level (gateway). */
  info: (message: string, meta?: Record<string, unknown>) => void;

  /** Warn-level (gateway). */
  warn: (message: string, meta?: Record<string, unknown>) => void;

  /** Error-level (gateway). */
  error: (message: string, meta?: Record<string, unknown>) => void;

  /**
   * Emit a gateway-level summary.
   * Use this at the start/end of significant operations (sync, search, flush).
   */
  summary: (message: string, meta?: Record<string, unknown>) => void;

  /** Create a child logger with an appended subsystem prefix. */
  child: (name: string) => MemoryTraceLogger;
};

export function createMemoryTraceLogger(subsystem = "memory"): MemoryTraceLogger {
  const gateway = createSubsystemLogger(subsystem);

  const logger: MemoryTraceLogger = {
    gateway,
    logFile: () => undefined,

    trace: (message, meta) => {
      gateway.debug(message, meta);
    },

    debug: (message, meta) => {
      gateway.debug(message, meta);
    },

    info: (message, meta) => {
      gateway.info(message, meta);
    },

    warn: (message, meta) => {
      gateway.warn(message, meta);
    },

    error: (message, meta) => {
      gateway.error(message, meta);
    },

    summary: (message, meta) => {
      gateway.info(message, meta);
    },

    child: (name) => createMemoryTraceLogger(`${subsystem}/${name}`),
  };

  return logger;
}

/** Singleton memory trace logger. */
export const memLog = createMemoryTraceLogger("memory");
