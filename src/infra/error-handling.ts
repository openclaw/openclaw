/**
 * Enhanced error handling utilities for improved stability and debugging.
 *
 * This module provides:
 * - Structured error types with consistent patterns
 * - Error aggregation for concurrent operations
 * - Context-aware error wrapping with metadata
 * - Async error boundary utilities
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage, extractErrorCode, detectErrorKind, type ErrorKind } from "./errors.js";

const log = createSubsystemLogger("error-handling");

/**
 * Base class for infrastructure errors with structured metadata.
 */
export class InfraError extends Error {
  readonly code: string;
  readonly metadata: Record<string, unknown>;
  readonly timestamp: Date;

  constructor(
    message: string,
    options?: {
      code?: string;
      cause?: unknown;
      metadata?: Record<string, unknown>;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "InfraError";
    this.code = options?.code ?? "INFRA_ERROR";
    this.metadata = options?.metadata ?? {};
    this.timestamp = new Date();
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      metadata: this.metadata,
      timestamp: this.timestamp.toISOString(),
      cause: this.cause instanceof Error ? formatErrorMessage(this.cause) : this.cause,
    };
  }
}

/**
 * Error thrown when multiple concurrent operations fail.
 */
export class AggregateInfraError extends InfraError {
  readonly errors: readonly unknown[];

  constructor(
    message: string,
    errors: unknown[],
    options?: {
      code?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: options?.code ?? "AGGREGATE_ERROR",
      metadata: {
        ...options?.metadata,
        errorCount: errors.length,
      },
    });
    this.name = "AggregateInfraError";
    this.errors = Object.freeze([...errors]);
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      errors: this.errors.map((e) => (e instanceof Error ? formatErrorMessage(e) : e)),
    };
  }
}

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends InfraError {
  readonly timeoutMs: number;

  constructor(
    message: string,
    timeoutMs: number,
    options?: {
      cause?: unknown;
      metadata?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: "TIMEOUT",
      cause: options?.cause,
      metadata: { ...options?.metadata, timeoutMs },
    });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when a resource cleanup operation fails.
 */
export class CleanupError extends InfraError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      metadata?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: "CLEANUP_FAILED",
      cause: options?.cause,
      metadata: options?.metadata,
    });
    this.name = "CleanupError";
  }
}

export type ErrorContext = {
  operation: string;
  subsystem?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Wraps an error with additional context information.
 */
export function wrapError(err: unknown, context: ErrorContext): InfraError {
  const message = `${context.operation} failed: ${formatErrorMessage(err)}`;
  return new InfraError(message, {
    code: extractErrorCode(err) ?? "OPERATION_FAILED",
    cause: err,
    metadata: {
      ...context.metadata,
      subsystem: context.subsystem,
      operation: context.operation,
    },
  });
}

/**
 * Executes an async function with error boundary protection.
 * Logs errors and optionally transforms them before re-throwing.
 */
export async function withErrorBoundary<T>(
  fn: () => Promise<T>,
  context: ErrorContext & {
    onError?: (err: unknown) => void;
    transform?: (err: unknown) => unknown;
    suppressLog?: boolean;
  },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!context.suppressLog) {
      const subsystemLog = context.subsystem ? createSubsystemLogger(context.subsystem) : log;
      subsystemLog.error(`${context.operation} failed: ${formatErrorMessage(err)}`);
    }

    context.onError?.(err);

    if (context.transform) {
      throw context.transform(err);
    }

    throw wrapError(err, context);
  }
}

/**
 * Executes multiple async operations concurrently with error aggregation.
 * Returns results for successful operations and aggregates failures.
 * Uses Promise.allSettled to ensure all operations complete before returning,
 * even in fail-fast mode.
 */
export async function withAggregatedErrors<T>(
  operations: Array<{
    label: string;
    fn: () => Promise<T>;
  }>,
  options?: {
    continueOnError?: boolean;
    context?: Omit<ErrorContext, "operation">;
  },
): Promise<{
  results: Array<{ label: string; value: T }>;
  errors: Array<{ label: string; error: unknown }>;
}> {
  const results: Array<{ label: string; value: T }> = [];
  const errors: Array<{ label: string; error: unknown }> = [];

  const promises = operations.map(async ({ label, fn }) => {
    try {
      const value = await fn();
      results.push({ label, value });
    } catch (err) {
      errors.push({ label, error: err });
    }
  });

  // Always wait for all operations to settle to avoid background operations
  await Promise.allSettled(promises);

  if (errors.length > 0 && !options?.continueOnError) {
    throw new AggregateInfraError(
      `${errors.length} operation(s) failed`,
      errors.map((e) => e.error),
      {
        metadata: {
          ...options?.context?.metadata,
          failedOperations: errors.map((e) => e.label),
        },
      },
    );
  }

  return { results, errors };
}

/**
 * Executes an async function with a timeout.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  options?: {
    context?: ErrorContext;
    onTimeout?: () => void;
  },
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    options?.onTimeout?.();
  }, timeoutMs);

  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(
            new TimeoutError(`Operation timed out after ${timeoutMs}ms`, timeoutMs, {
              metadata: options?.context?.metadata,
            }),
          );
        });
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determines if an error is recoverable based on its kind.
 */
export function isRecoverableError(err: unknown): boolean {
  const kind = detectErrorKind(err);
  return kind === "timeout" || kind === "rate_limit";
}

/**
 * Determines if an error should trigger a retry.
 */
export function shouldRetryError(err: unknown): boolean {
  const kind = detectErrorKind(err);
  if (kind === "refusal" || kind === "context_length") {
    return false;
  }

  const code = extractErrorCode(err)?.toLowerCase();
  if (code === "econnreset" || code === "econnrefused" || code === "etimedout") {
    return true;
  }

  return isRecoverableError(err);
}

/**
 * Extracts a user-friendly error message suitable for display.
 */
export function getUserFriendlyMessage(err: unknown): string {
  const kind = detectErrorKind(err);
  switch (kind) {
    case "refusal":
      return "The request was declined due to content policy restrictions.";
    case "timeout":
      return "The operation timed out. Please try again.";
    case "rate_limit":
      return "Too many requests. Please wait a moment and try again.";
    case "context_length":
      return "The request was too large. Please try with less content.";
    default:
      return formatErrorMessage(err);
  }
}

/**
 * Creates a structured error report for logging/debugging.
 * Includes a depth guard to prevent unbounded recursion on circular cause chains.
 */
export function createErrorReport(err: unknown, depth = 0): Record<string, unknown> {
  const maxDepth = 10;
  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    message: formatErrorMessage(err),
    kind: detectErrorKind(err) ?? "unknown",
    code: extractErrorCode(err),
  };

  if (err instanceof InfraError) {
    report.metadata = err.metadata;
    report.structured = err.toJSON();
  }

  if (err instanceof Error) {
    report.name = err.name;
    report.stack = err.stack;
    if (err.cause && depth < maxDepth) {
      report.cause = createErrorReport(err.cause, depth + 1);
    } else if (err.cause) {
      report.cause = "[max depth exceeded]";
    }
  }

  return report;
}

export type { ErrorKind };
