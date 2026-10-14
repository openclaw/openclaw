import { ErrorCodes, isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { formatConfigMutationError } from "./config-draft-model.ts";
import type { RuntimeConfigState } from "./config-state-model.ts";

// Publication and read-recovery outcomes outrank nested pre-write conflict text.
export function configMutationFailure(
  state: RuntimeConfigState,
  error: unknown,
  submittedRaw?: string | null,
) {
  let message =
    submittedRaw !== undefined
      ? formatConfigMutationError(error, submittedRaw)
      : formatUiError(error);
  const details =
    error instanceof GatewayRequestError && isRecord(error.details) ? error.details : null;
  const hasRecoveryOutcome =
    details && (details.publication === "partial" || details.publication === "complete");
  if (hasRecoveryOutcome) {
    if (details.rollbackStatus !== "restored") {
      if (typeof details.configPath === "string") {
        message = t(
          details.rollbackStatus === "not-restored"
            ? "configView.recoveryNotRestored"
            : "configView.recoveryUnknown",
          { path: details.configPath },
        );
        if (typeof details.recoveryBackupPath === "string") {
          message += "\n" + t("configView.recoveryBackup", { path: details.recoveryBackupPath });
        }
      }
      state.configRecoveryError = message;
    }
    return { status: "error" as const, message };
  }
  if (message.includes("config changed since last load")) {
    return { status: "conflict" as const, message };
  }
  // Only a correlated validation response proves this attempt never published.
  // Receipt retirement also covers permission failures and restored writes.
  if (
    error instanceof GatewayRequestError &&
    isGatewayProtocolResponseError(error) &&
    error.gatewayCode === ErrorCodes.INVALID_REQUEST &&
    details?.publication === undefined &&
    details?.persistedConfig === undefined &&
    Array.isArray(details?.issues) &&
    details.issues.length > 0 &&
    details.issues.every(
      (issue) =>
        isRecord(issue) && typeof issue.path === "string" && typeof issue.message === "string",
    )
  ) {
    return {
      status: "rejected" as const,
      message: message.replace(/^GatewayRequestError: /u, ""),
    };
  }
  return { status: "error" as const, message };
}

export function isDefinitiveConfigMutationRejection(err: unknown): boolean {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = isRecord(err.details) ? err.details : null;
  if (details && (details.publication === "partial" || details.publication === "complete")) {
    return details.rollbackStatus === "restored";
  }
  return err.gatewayCode === ErrorCodes.INVALID_REQUEST || err.gatewayCode === ErrorCodes.FORBIDDEN;
}
