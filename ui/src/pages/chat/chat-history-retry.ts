import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sleepWithAbort } from "@openclaw/retry";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isAgentDatabaseInspectionPendingError,
  resolveGatewayReadRetryDelayMs,
} from "../../lib/gateway-availability.ts";

export const CHAT_HISTORY_RETRY_WINDOW_MS = 60_000;

type RetryableChatReadError = GatewayRequestError | GatewayProtocolRequestTimeoutError;

/** One deadline and retry policy for tail, older-page, and speculative history reads. */
export async function retryChatHistoryRead<T>(options: {
  method: "chat.history" | "chat.startup";
  controller: AbortController;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  request: (signal: AbortSignal) => Promise<T>;
  onRetry?: () => void;
}): Promise<T> {
  const { controller, method } = options;
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let lastRetryableError: unknown;
  const deadlineAt = Date.now() + CHAT_HISTORY_RETRY_WINDOW_MS;
  const timeout = setTimeout(
    () =>
      controller.abort(
        isAgentDatabaseInspectionPendingError(lastRetryableError)
          ? lastRetryableError
          : new GatewayProtocolRequestTimeoutError(
              { method, timeoutMs: CHAT_HISTORY_RETRY_WINDOW_MS, requestSent: true },
              t("chat.historyRequestTimedOut"),
            ),
      ),
    CHAT_HISTORY_RETRY_WINDOW_MS,
  );
  const shouldRetry = () => !signal.aborted && Date.now() < deadlineAt && options.isCurrent();
  try {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await options.request(signal);
      } catch (error) {
        if (!shouldRetry() || !isRetryableChatReadError(error, method)) {
          throw error;
        }
        lastRetryableError = error;
        options.onRetry?.();
        await sleepWithAbort(resolveGatewayReadRetryDelayMs(error, attempt), signal);
        if (!shouldRetry()) {
          throw error;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function isRetryableChatReadError(
  err: unknown,
  method: string,
): err is RetryableChatReadError {
  if (err instanceof GatewayProtocolRequestTimeoutError) {
    return err.method === method;
  }
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = asOptionalRecord(err.details);
  if (err.gatewayCode === "INVALID_REQUEST") {
    // A fresh subscription rechecks access; never replay a mutation or a denial.
    return (
      method === "sessions.messages.subscribe" &&
      details?.code === "SESSION_MUTATION_AUTHORIZATION_CHANGED" &&
      details.method === method
    );
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const detailMethod = details?.method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

export function formatChatHistoryLoadError(error: unknown): string {
  if (isAgentDatabaseInspectionPendingError(error)) {
    return t("chat.agentDatabaseWarming");
  }
  return error instanceof GatewayProtocolRequestTimeoutError
    ? t("chat.historyRequestTimedOut")
    : formatUiError(error);
}
