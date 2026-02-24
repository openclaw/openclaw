import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

export type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: RuntimeEnv;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
  retry?: boolean;
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

function toPrintableLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return `[unserializable object: ${String(err)}]`;
    }
  }
  return String(value);
}

function formatNestedRetryErrorContext(err: unknown): string {
  if (typeof err !== "object" || err === null || !("error" in err)) {
    return "error: undefined | cause: undefined | stack: undefined";
  }
  const nestedError = (err as { error?: unknown }).error;
  if (typeof nestedError !== "object" || nestedError === null) {
    return `error: ${toPrintableLogValue(nestedError)} | cause: undefined | stack: undefined`;
  }
  const cause = "cause" in nestedError ? (nestedError as { cause?: unknown }).cause : undefined;
  const stack = "stack" in nestedError ? (nestedError as { stack?: unknown }).stack : undefined;
  return `error: ${toPrintableLogValue(nestedError)} | cause: ${toPrintableLogValue(cause)} | stack: ${toPrintableLogValue(stack)}`;
}

export async function withTelegramApiErrorLogging<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
  retry = true,
}: TelegramApiLoggingParams<T>): Promise<T> {
  try {
    if (retry) {
      return await retryAsync(fn, {
        attempts: 4,
        minDelayMs: 250,
        maxDelayMs: 5000,
        jitter: 0.2,
        shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
        onRetry: (info) => {
          const log = resolveTelegramApiLogger(runtime, logger);
          log(
            `telegram ${operation} retry ${info.attempt}/${info.maxAttempts - 1} in ${info.delayMs}ms due to: ${formatErrorMessage(info.err)} (${formatNestedRetryErrorContext(info.err)})`,
          );
        },
      });
    }
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
