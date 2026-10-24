import { GatewayRequestError } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";

export function linkReaderErrorMessage(error: unknown): string {
  // Gateway readers author actionable messages; local faults get neutral copy.
  return error instanceof GatewayRequestError
    ? formatUiError(error.message, t("linkReader.unavailable"))
    : t("linkReader.unavailable");
}
