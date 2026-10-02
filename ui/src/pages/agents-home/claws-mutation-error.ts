import { GatewayRequestError } from "../../api/gateway.ts";

// INVALID_REQUEST is reserved for validation, plan, and consent rejection before mutation.
export function isRejectedClawMutation(error: unknown): boolean {
  return error instanceof GatewayRequestError && error.code === "INVALID_REQUEST";
}
