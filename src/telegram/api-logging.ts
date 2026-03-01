import { danger } from "../globals.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";

export type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: RuntimeEnv;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

function resolveTelegramApiLogger(runtime?: RuntimeEnv, logger?: TelegramApiLogger) {
  if (logger) {
    return logger;
  }
  if (runtime?.error) {
    return runtime.error;
  }
  return (message: string) => fallbackLogger.error(message);
}

export async function withTelegramApiErrorLogging<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
}: TelegramApiLoggingParams<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!shouldLog || shouldLog(err)) {
      const errText = formatErrorMessage(err);
      const log = resolveTelegramApiLogger(runtime, logger);
      log(danger(`telegram ${operation} failed: ${errText}`));
    }
    throw err;
  }
}

type TelegramApiRetryParams<T> = TelegramApiLoggingParams<T> & {
  maxAttempts?: number;
};

const TELEGRAM_API_RETRY_POLICY = {
  initialMs: 500,
  maxMs: 5000,
  factor: 1.5,
  jitter: 0.1,
};

/**
 * Wrapper that combines API error logging with automatic retry for recoverable errors.
 * Uses exponential backoff for transient failures (network, timeouts, etc.).
 */
export async function withTelegramApiRetry<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
  maxAttempts = 3,
}: TelegramApiRetryParams<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Check if error is recoverable
      const { isRecoverableTelegramNetworkError } = await import("./network-errors.js");
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "send" });

      if (!isRecoverable || attempt === maxAttempts) {
        // Log final error
        if (!shouldLog || shouldLog(err)) {
          const errText = formatErrorMessage(err);
          const log = resolveTelegramApiLogger(runtime, logger);
          const suffix = isRecoverable ? ` (failed after ${attempt} attempts)` : "";
          log(danger(`telegram ${operation} failed: ${errText}${suffix}`));
        }
        throw err;
      }

      // Wait before retry with exponential backoff
      const delayMs = computeBackoff(TELEGRAM_API_RETRY_POLICY, attempt - 1);
      await sleepWithAbort(delayMs).catch(() => {
        // Abort signal received, rethrow immediately
        throw err;
      });
    }
  }

  // Should not reach here, but throw last error if it does
  throw lastError;
}
