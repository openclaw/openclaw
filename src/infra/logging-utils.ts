/**
 * Structured logging utilities for improved observability.
 *
 * This module provides:
 * - Consistent log context management
 * - Performance timing utilities
 * - Operation tracking with correlation IDs
 */

import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { generateSecureHex } from "./secure-random.js";

export type LogContext = {
  correlationId: string;
  operation: string;
  subsystem: string;
  startTime: number;
  metadata: Record<string, unknown>;
};

/**
 * Creates a new log context with a unique correlation ID.
 */
export function createLogContext(
  operation: string,
  subsystem: string,
  metadata?: Record<string, unknown>,
): LogContext {
  return {
    correlationId: generateSecureHex(8),
    operation,
    subsystem,
    startTime: Date.now(),
    metadata: metadata ?? {},
  };
}

/**
 * Calculates elapsed time from a log context.
 */
export function getElapsedMs(context: LogContext): number {
  return Date.now() - context.startTime;
}

/**
 * Formats a log context into a prefix string.
 */
export function formatLogPrefix(context: LogContext): string {
  return `[${context.correlationId}] ${context.operation}`;
}

export type OperationLogger = {
  context: LogContext;
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
  debug: (message: string, extra?: Record<string, unknown>) => void;
  started: () => void;
  completed: (result?: Record<string, unknown>) => void;
  failed: (err: unknown) => void;
};

/**
 * Creates a logger bound to a specific operation context.
 * Provides consistent logging with correlation ID and timing.
 */
export function createOperationLogger(
  operation: string,
  subsystem: string,
  metadata?: Record<string, unknown>,
): OperationLogger {
  const context = createLogContext(operation, subsystem, metadata);
  const logger: SubsystemLogger = createSubsystemLogger(subsystem);
  const prefix = formatLogPrefix(context);

  const formatMessage = (message: string, extra?: Record<string, unknown>): string => {
    const parts = [prefix, message];
    if (extra && Object.keys(extra).length > 0) {
      parts.push(JSON.stringify(extra));
    }
    return parts.join(" ");
  };

  const formatWithTiming = (message: string, extra?: Record<string, unknown>): string => {
    const elapsedMs = getElapsedMs(context);
    return formatMessage(message, { ...extra, elapsedMs });
  };

  return {
    context,
    info: (message, extra) => logger.info(formatMessage(message, extra)),
    warn: (message, extra) => logger.warn(formatMessage(message, extra)),
    error: (message, extra) => logger.error(formatMessage(message, extra)),
    debug: (message, extra) => logger.debug(formatMessage(message, extra)),
    started: () => logger.info(formatMessage("started", context.metadata)),
    completed: (result) => logger.info(formatWithTiming("completed", result)),
    failed: (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(formatWithTiming("failed", { error: errorMessage }));
    },
  };
}

export type TrackedOperation<T> = {
  promise: Promise<T>;
  context: LogContext;
  cancel: () => void;
};

/**
 * Wraps an async operation with logging and tracking.
 */
export function trackOperation<T>(
  operation: string,
  subsystem: string,
  fn: (logger: OperationLogger, signal: AbortSignal) => Promise<T>,
  metadata?: Record<string, unknown>,
): TrackedOperation<T> {
  const controller = new AbortController();
  const opLogger = createOperationLogger(operation, subsystem, metadata);

  opLogger.started();

  const promise = fn(opLogger, controller.signal)
    .then((result) => {
      opLogger.completed();
      return result;
    })
    .catch((err) => {
      opLogger.failed(err);
      throw err;
    });

  return {
    promise,
    context: opLogger.context,
    cancel: () => controller.abort(),
  };
}

/**
 * Measures and logs execution time for an async operation.
 */
export async function withTiming<T>(
  operation: string,
  subsystem: string,
  fn: () => Promise<T>,
  options?: {
    warnThresholdMs?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<T> {
  const opLogger = createOperationLogger(operation, subsystem, options?.metadata);
  const start = Date.now();

  try {
    const result = await fn();
    const elapsedMs = Date.now() - start;

    if (options?.warnThresholdMs && elapsedMs > options.warnThresholdMs) {
      opLogger.warn(`slow operation`, { elapsedMs, threshold: options.warnThresholdMs });
    } else {
      opLogger.debug(`completed`, { elapsedMs });
    }

    return result;
  } catch (err) {
    opLogger.failed(err);
    throw err;
  }
}

/**
 * Creates a rate-limited logger that suppresses repeated messages.
 */
export function createRateLimitedLogger(
  subsystem: string,
  options?: {
    windowMs?: number;
    maxPerWindow?: number;
    maxEntries?: number;
  },
): SubsystemLogger {
  const windowMs = options?.windowMs ?? 60_000;
  const maxPerWindow = options?.maxPerWindow ?? 10;
  const maxEntries = options?.maxEntries ?? 1000;
  const logger = createSubsystemLogger(subsystem);
  const counts = new Map<string, { count: number; windowStart: number; suppressed: number }>();

  const evictExpiredEntries = (): void => {
    if (counts.size <= maxEntries) {
      return;
    }
    const now = Date.now();
    // Remove expired entries when over threshold
    for (const [key, state] of counts) {
      if (now - state.windowStart > windowMs) {
        counts.delete(key);
      }
    }
    // If still over limit, remove oldest entries
    if (counts.size > maxEntries) {
      const entries = [...counts.entries()].toSorted((a, b) => a[1].windowStart - b[1].windowStart);
      const toRemove = entries.slice(0, counts.size - maxEntries);
      for (const [key] of toRemove) {
        counts.delete(key);
      }
    }
  };

  const checkRateLimit = (message: string): boolean => {
    const now = Date.now();
    const state = counts.get(message);

    if (!state || now - state.windowStart > windowMs) {
      evictExpiredEntries();
      counts.set(message, { count: 1, windowStart: now, suppressed: 0 });
      return true;
    }

    if (state.count >= maxPerWindow) {
      state.suppressed += 1;
      return false;
    }

    state.count += 1;
    return true;
  };

  const maybeLogSuppressed = (message: string): void => {
    const state = counts.get(message);
    if (state && state.suppressed > 0) {
      logger.warn(`suppressed ${state.suppressed} repeated messages: ${message.slice(0, 50)}...`);
      state.suppressed = 0;
    }
  };

  return {
    info: (message) => {
      maybeLogSuppressed(message);
      if (checkRateLimit(message)) {
        logger.info(message);
      }
    },
    warn: (message) => {
      maybeLogSuppressed(message);
      if (checkRateLimit(message)) {
        logger.warn(message);
      }
    },
    error: (message) => {
      maybeLogSuppressed(message);
      if (checkRateLimit(message)) {
        logger.error(message);
      }
    },
    debug: (message) => {
      maybeLogSuppressed(message);
      if (checkRateLimit(message)) {
        logger.debug(message);
      }
    },
  };
}
