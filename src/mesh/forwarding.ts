import { randomUUID } from "node:crypto";
import type { PeerRegistry } from "./peer-registry.js";
import type { MeshForwardPayload } from "./types.js";

export type ForwardResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Forward a message to a mesh peer for delivery on a channel
 * that is not available locally.
 */
export async function forwardMessageToPeer(params: {
  peerRegistry: PeerRegistry;
  peerDeviceId: string;
  channel: string;
  to: string;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  accountId?: string;
  originGatewayId: string;
  idempotencyKey?: string;
}): Promise<ForwardResult> {
  const payload: MeshForwardPayload = {
    channel: params.channel,
    to: params.to,
    message: params.message,
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    accountId: params.accountId,
    originGatewayId: params.originGatewayId,
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
  };

  const result = await params.peerRegistry.invoke({
    deviceId: params.peerDeviceId,
    method: "mesh.message.forward",
    params: payload,
    timeoutMs: 30_000,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error?.message ?? "mesh forward failed",
    };
  }

  const resultPayload = result.payload as { messageId?: string } | undefined;
  return {
    ok: true,
    messageId: resultPayload?.messageId,
  };
}
