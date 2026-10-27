import { GatewayRequestError } from "../api/gateway-connect-errors.ts";

export function retryableGatewayError(message = "History is temporarily unavailable") {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    retryAfterMs: 100,
  });
}

export function suspendingGatewayError(message = "Gateway is suspending") {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    details: { reason: "gateway-suspending", phase: "draining" },
  });
}
