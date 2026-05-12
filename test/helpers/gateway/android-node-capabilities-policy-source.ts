import type { GatewayConnectionDetails } from "../../../src/gateway/call.js";

export function shouldFetchRemotePolicyConfig(details: GatewayConnectionDetails): boolean {
  return details.urlSource !== "local loopback";
}
