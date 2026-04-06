import type { GatewayConnectionDetails } from "./call.js";

export function shouldFetchRemotePolicyConfig(details: GatewayConnectionDetails): boolean {
  return details.urlSource !== "local loopback";
}
