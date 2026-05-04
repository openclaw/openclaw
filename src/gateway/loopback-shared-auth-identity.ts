import { isLoopbackIpAddress } from "../shared/net/ip.js";

export function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

/**
 * A backend-mode GatewayClient launched against a trusted loopback Gateway with a
 * preauth token or password should not attach the host's persisted device identity.
 * Sending it can re-trigger scope-upgrade approvals based on a stale paired baseline,
 * wedging short-lived clients (operator approvals, ACP bridge) before they finish
 * initialization. Remote URLs and unauthenticated loopback paths keep their normal
 * device identity behavior so legitimate scope-upgrade prompts still surface.
 */
export function shouldOmitGatewayClientDeviceIdentity(params: {
  url: string;
  token?: string;
  password?: string;
}): boolean {
  return Boolean((params.token || params.password) && isLoopbackGatewayUrl(params.url));
}
