import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayClient } from "./server-methods/client-types.js";

export function createSessionMessageBodyOmission(
  subscriptionKeys: readonly string[],
  subscribers: Pick<SessionMessageSubscriberRegistry, "get">,
): (client: GatewayClient) => boolean {
  // Read live connection preferences and every exact observer at delivery time.
  return (client) =>
    hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.ROSTER_MESSAGE_BODIES_OPTIONAL) &&
    !(client.includeSessionMessageBodies ?? client.connect.includeSessionMessageBodies) &&
    !subscriptionKeys.some((key) => subscribers.get(key).has(client.connId ?? ""));
}
