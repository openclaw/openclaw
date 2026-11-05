import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";

/**
 * The client's transport went away before the request finished. This is an expected cancellation,
 * not an authorization change: nothing about the requester identity was observed to differ.
 */
export class GatewayRequestCancelledError extends Error {
  readonly error = errorShape(
    ErrorCodes.UNAVAILABLE,
    "Gateway request cancelled because its connection closed",
    { retryable: true, details: { reason: "connection-closed" } },
  );

  constructor() {
    super("Gateway request cancelled: connection closed");
    this.name = "GatewayRequestCancelledError";
  }
}

export function isGatewayRequestCancelledError(
  value: unknown,
): value is GatewayRequestCancelledError {
  return value instanceof GatewayRequestCancelledError;
}

/** Handlers surface cancellation to the dispatcher instead of reporting an authority change. */
export function rethrowGatewayRequestCancelledError(error: unknown): void {
  if (isGatewayRequestCancelledError(error)) {
    throw error;
  }
}
