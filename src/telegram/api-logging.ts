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
            `telegram ${operation} retry ${info.attempt}/${info.maxAttempts - 1} in ${info.delayMs}ms due to: ${formatErrorMessage(info.err)}`,
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
