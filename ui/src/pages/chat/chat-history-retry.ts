import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isAgentDatabaseInspectionPendingError } from "../../lib/gateway-availability.ts";

export const CHAT_HISTORY_RETRY_WINDOW_MS = 60_000;

type RetryableChatReadError = GatewayRequestError | GatewayProtocolRequestTimeoutError;

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
