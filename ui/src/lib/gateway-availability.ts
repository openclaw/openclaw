import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isGatewayClosingUnavailableError,
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
} from "../../../packages/gateway-protocol/src/restart-unavailable.ts";
import { isRetryableGatewayStartupUnavailableError } from "../../../packages/gateway-protocol/src/startup-unavailable.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export function isAgentDatabaseInspectionPendingError(error: unknown): boolean {
  return (
    error instanceof GatewayProtocolRequestError &&
    error.gatewayCode === "UNAVAILABLE" &&
    error.retryable &&
    asOptionalRecord(error.details)?.code === "agent-database-inspection-pending"
  );
}

/** Replayable reads back off while respecting the server's minimum wait. */
export function resolveGatewayReadRetryDelayMs(error: unknown, attempt = 0): number {
  const backoff = Math.min(500 * 2 ** Math.min(attempt, 4), 5_000);
  const hint = error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined;
  return typeof hint === "number" && Number.isFinite(hint) ? Math.max(hint, backoff) : backoff;
}

function isGatewayUnavailableError(error: unknown): boolean {
  return (
    (error instanceof GatewayProtocolRequestError &&
      (isGatewaySuspendUnavailableError(error) ||
        isGatewayRestartUnavailableError(error) ||
        isGatewayClosingUnavailableError(error))) ||
    isRetryableGatewayStartupUnavailableError(error) ||
    isAgentDatabaseInspectionPendingError(error)
  );
}

export function isGatewayAvailable(
  snapshot: Pick<ApplicationGatewaySnapshot, "phase" | "restartPending" | "suspensionPhase">,
): boolean {
  return (
    snapshot.phase === "connected" &&
    snapshot.restartPending !== true &&
    (snapshot.suspensionPhase === undefined || snapshot.suspensionPhase === "accepting")
  );
}

export function isAwaitingGatewayFailure(
  error: unknown,
  snapshot:
    | Pick<ApplicationGatewaySnapshot, "phase" | "restartPending" | "suspensionPhase">
    | null
    | undefined,
): boolean {
  return (
    isGatewayUnavailableError(error) ||
    (!(error instanceof GatewayProtocolRequestError) &&
      snapshot != null &&
      !isGatewayAvailable(snapshot))
  );
}
