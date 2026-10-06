import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";
import {
  classifyGatewayConnectFailure,
  ConnectErrorDetailCodes,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";

type GatewayProbeReachabilityEvidence = NonNullable<DaemonStatus["rpc"]>;

export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE =
  "Gateway is reachable, but this CLI has no token/password or paired device token for read-scope health RPCs.";
export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE = "Gateway credentials required";
export const GATEWAY_HEALTH_REACHABLE_LINE = "Gateway: reachable";
export const GATEWAY_HEALTH_RATE_LIMITED_MESSAGE =
  "Gateway authentication is temporarily rate-limited. Wait for the temporary lockout to expire, then retry.";
export const GATEWAY_HEALTH_RATE_LIMITED_TITLE = "Gateway authentication rate-limited";

function gatewayProbeFailureKind(status: GatewayProbeReachabilityEvidence) {
  return (
    status.connectFailure?.kind ?? classifyGatewayConnectFailure({ message: status.error }).kind
  );
}

export function gatewayProbeResultWasRateLimited(
  status: GatewayProbeReachabilityEvidence,
): boolean {
  return gatewayProbeFailureKind(status) === "rate-limited";
}

export function gatewayConnectErrorWasRateLimited(error: unknown): boolean {
  if (!isGatewayProtocolResponseError(error)) {
    return false;
  }
  return (
    classifyGatewayConnectFailure({
      details: error.details,
      message: error.message,
    }).kind === "rate-limited"
  );
}

export function gatewayProbeResultSawGateway(status: GatewayProbeReachabilityEvidence): boolean {
  return status.ok || status.gatewayReached === true;
}

export function buildCredentialsRequiredHealthDiagnostic() {
  return {
    ok: false,
    error: {
      type: "gateway_credentials_required",
      message: GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
    },
    gateway: {
      reachable: true,
    },
  };
}

export function buildRateLimitedHealthDiagnostic(error?: unknown) {
  const retryAfterCandidate =
    error instanceof Error ? (error as Error & { retryAfterMs?: unknown }).retryAfterMs : undefined;
  const retryAfterMs =
    typeof retryAfterCandidate === "number" &&
    Number.isSafeInteger(retryAfterCandidate) &&
    retryAfterCandidate >= 0
      ? retryAfterCandidate
      : undefined;
  return {
    ok: false,
    error: {
      type: "gateway_request_error",
      code: ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
      message: GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
    gateway: {
      reachable: true,
    },
  };
}
