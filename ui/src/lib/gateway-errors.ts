// Control UI shared Gateway error helpers.
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  readMissingScopeError,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";

function hasGatewayErrorDetail(err: unknown, expectedCode: string, detailCode: string): boolean {
  const error = asRecord(err);
  if (!error) {
    return false;
  }
  const code =
    typeof error.gatewayCode === "string"
      ? error.gatewayCode
      : typeof error.code === "string"
        ? error.code
        : null;
  return code === expectedCode && asRecord(error.details)?.code === detailCode;
}

/** Identifies an expired process-local wizard session without parsing public copy. */
export function isWizardNotFoundError(err: unknown): boolean {
  return hasGatewayErrorDetail(
    err,
    ErrorCodes.INVALID_REQUEST,
    GatewayErrorDetailCodes.WIZARD_NOT_FOUND,
  );
}

export function isSetupAdmissionBusyError(err: unknown): boolean {
  return hasGatewayErrorDetail(
    err,
    ErrorCodes.UNAVAILABLE,
    GatewayErrorDetailCodes.SETUP_ADMISSION_BUSY,
  );
}

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  // Retained custom elements can hold an earlier client error class.
  return (
    err instanceof Error &&
    err.name === "GatewayRequestError" &&
    readMissingScopeError(err)?.missingScope === "operator.read"
  );
}

export function isArchiveAccessDeniedError(err: unknown): boolean {
  return (
    asRecord(err)?.gatewayCode === ErrorCodes.FORBIDDEN || isMissingOperatorReadScopeError(err)
  );
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}
