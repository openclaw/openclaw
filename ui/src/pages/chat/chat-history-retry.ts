import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isAgentDatabaseInspectionPendingError } from "../../lib/gateway-availability.ts";

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
  if (isAgentDatabaseInspectionPendingError(error)) {
    return t("chat.agentDatabaseWarming");
  }
  return error instanceof GatewayProtocolRequestTimeoutError
    ? t("chat.historyRequestTimedOut")
    : formatUiError(error);
}
