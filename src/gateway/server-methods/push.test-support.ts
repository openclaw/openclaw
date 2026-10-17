import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import type { WebPushSubscription } from "../../infra/push-web-store.records.js";
import type { GatewayClient } from "./types.js";

export function pushClient(
  profileId: string,
  connId: string,
  connectionSignal: AbortSignal,
  deviceId = "browser-device",
  scopes = ["operator.write"],
): GatewayClient {
  return {
    connId,
    connectionSignal,
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes,
      device: {
        id: deviceId,
        publicKey: "synthetic-public-key",
        signature: "synthetic-signature",
        signedAt: 1,
        nonce: "synthetic-nonce",
      },
    },
    authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 1 },
  };
}

export function pushSubscription(
  endpoint: string,
  keys: WebPushSubscription["keys"],
  subscriptionId: string,
): WebPushSubscription {
  return { subscriptionId, endpoint, keys, createdAtMs: 1, updatedAtMs: 1 };
}
