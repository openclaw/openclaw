import { GatewayRequestError } from "../../api/gateway.ts";

export function isUnknownSystemInfoMethodError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: system.info")
  );
}
