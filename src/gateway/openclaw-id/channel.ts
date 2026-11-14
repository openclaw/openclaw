// Which OpenClaw ID write channel a Gateway client arrived on. The ingress
// listener decides this by path, never by source IP or headers: relayed
// tunnel traffic reaches the Gateway on the local host but is never treated
// as direct loopback, so it can never run a root ceremony (spec section 4).
import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayClient } from "../server-methods/client-types.js";
import { resolveAuthenticatedPersonalGatewayProfileId } from "../server-methods/gateway-personal-caller.js";

/**
 * `local_operator` for an authenticated direct-loopback client, `tunnel` for a
 * client relayed by the tunnel child, otherwise undefined (no OpenClaw ID writes).
 * The mailbox channel is the Gateway's own Discovery reader, never a client.
 */
export function resolveOpenClawIdClientChannel(
  client: Pick<GatewayClient, "internal"> | null | undefined,
): Exclude<Channel, "mailbox"> | undefined {
  if (client?.internal?.openclawIdPeerKey) {
    return "tunnel";
  }
  return client?.internal?.isLocalClient === true ? "local_operator" : undefined;
}

/** The authenticated device key W of a relayed client. */
export function resolveOpenClawIdClientPeerKey(
  client: Pick<GatewayClient, "internal"> | null | undefined,
): string | undefined {
  return client?.internal?.openclawIdPeerKey;
}

/**
 * How a client may sign in with OpenClaw ID. The direct-loopback operator uses the popup
 * (the issuer redirects to this machine). A connection whose profile comes from a verified
 * personal identity (Tailscale Serve, a trusted proxy, an enterprise principal) uses the
 * device grant. The sign-in only proves which account the browser holds; it grants nothing.
 * Shared token or password connections, OpenClaw ID tunnel clients and host-bound ingress
 * grants carry no personal identity of their own and cannot sign in.
 */
export function resolveOpenClawIdSignInRoute(
  client: GatewayClient | null | undefined,
): "popup" | "device" | null {
  const channel = resolveOpenClawIdClientChannel(client);
  if (channel === "local_operator") {
    return "popup";
  }
  if (!client || channel === "tunnel" || client.internal?.remoteIngressPrincipal) {
    return null;
  }
  return resolveAuthenticatedPersonalGatewayProfileId(client) ? "device" : null;
}
