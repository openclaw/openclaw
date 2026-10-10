import { expectDefined } from "@openclaw/normalization-core";
import type { callGateway as gatewayCall } from "../../gateway/call.js";

export type CallGatewayRequest = Parameters<typeof gatewayCall>[0];

export function readHistoryDetails(result: { details: unknown }) {
  return result.details as Record<string, unknown>;
}

export function requireGatewayRequest(
  requests: CallGatewayRequest[],
  method: string,
): CallGatewayRequest {
  return expectDefined(
    requests.find((request) => request.method === method),
    `${method} request test invariant`,
  );
}

export function readMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}
