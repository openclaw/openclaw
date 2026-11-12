// Which OpenClaw ID write channel a Gateway client arrived on. The ingress
// listener decides this by path, never by source IP or headers: relayed
// tunnel traffic reaches the Gateway on the local host but is never treated
// as direct loopback, so it can never run a root ceremony (spec section 4).
import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayClient } from "../server-methods/client-types.js";

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
