import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

const DEFAULT_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;
export const CHAT_HISTORY_RETRY_WINDOW_MS = 60_000;

type RetryableChatReadError = GatewayRequestError | GatewayProtocolRequestTimeoutError;

/** Reads are replayable; subscription acquisition first settles its coordinator's compensation. */
export function isRetryableChatReadError(
  err: unknown,
  method: string,
): err is RetryableChatReadError {
  if (err instanceof GatewayProtocolRequestTimeoutError) {
    return err.method === method;
  }
  if (
    !(err instanceof GatewayRequestError) ||
    err.gatewayCode !== "UNAVAILABLE" ||
    !err.retryable
  ) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

export function formatChatHistoryLoadError(error: unknown): string {
  return error instanceof GatewayProtocolRequestTimeoutError
    ? t("chat.historyRequestTimedOut")
    : formatUiError(error);
}

export function resolveChatReadRetryDelayMs(err: RetryableChatReadError, attempt = 0): number {
  if (
    err instanceof GatewayRequestError &&
    typeof err.retryAfterMs === "number" &&
    Number.isFinite(err.retryAfterMs)
  ) {
    // Server hints are minimum waits; the owning consumer deadline bounds the operation.
    return Math.max(err.retryAfterMs, 100);
  }
  return Math.min(DEFAULT_RETRY_MS * 2 ** Math.min(attempt, 4), MAX_RETRY_MS);
}
