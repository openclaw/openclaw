import {
  ErrorCodes,
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  readMissingScopeError,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SETUP_ADMISSION_BUSY_ERROR_CODE,
  WIZARD_NOT_FOUND_ERROR_CODE,
} from "../../../packages/gateway-protocol/src/gateway-error-codes.js";

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
  return hasGatewayErrorDetail(err, ErrorCodes.INVALID_REQUEST, WIZARD_NOT_FOUND_ERROR_CODE);
}

export function isSetupAdmissionBusyError(err: unknown): boolean {
  return hasGatewayErrorDetail(err, ErrorCodes.UNAVAILABLE, SETUP_ADMISSION_BUSY_ERROR_CODE);
}

/** A typed permission rejection is terminal until connection authority changes. */
export function isGatewayAccessDeniedError(error: unknown): boolean {
  return (
    Boolean(readMissingScopeError(error)) ||
    (error instanceof GatewayProtocolRequestError && error.gatewayCode === ErrorCodes.FORBIDDEN)
  );
}

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  return readMissingScopeError(err)?.missingScope === "operator.read";
}

export function isArchiveAccessDeniedError(err: unknown): boolean {
  return (
    asRecord(err)?.gatewayCode === ErrorCodes.FORBIDDEN || isMissingOperatorReadScopeError(err)
  );
}

export async function formatMissingOperatorReadScopeMessage(
  feature: string,
  fallback: string,
): Promise<string> {
  try {
    const errors = await import("./permission-error.ts");
    return errors.formatMissingOperatorReadScopeMessage(feature);
  } catch {
    // Keep the Gateway denial visible if the optional error catalog cannot load.
    return fallback;
  }
}

/** Retry only a typed deadline or an explicitly retryable rejection of this read. */
export function isRetryableGatewayReadError(
  error: unknown,
  method: string,
): error is GatewayProtocolRequestError | GatewayProtocolRequestTimeoutError {
  if (error instanceof GatewayProtocolRequestTimeoutError) {
    return error.method === method;
  }
  if (
    !(error instanceof GatewayProtocolRequestError) ||
    error.gatewayCode !== ErrorCodes.UNAVAILABLE ||
    !error.retryable
  ) {
    return false;
  }
  const detailMethod = asRecord(error.details)?.method;
  return typeof detailMethod !== "string" || detailMethod === method;
}
