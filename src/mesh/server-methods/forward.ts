import type { ChannelId } from "../../channels/plugins/types.js";
import type { GatewayRequestHandlers } from "../../gateway/server-methods/types.js";
import type { DeviceIdentity } from "../../infra/device-identity.js";
import type { MeshForwardPayload } from "../types.js";

/**
 * Handler for mesh.message.forward — receives a forwarded message from a mesh peer
 * and delivers it using the local outbound delivery infrastructure.
 */
export function createMeshForwardHandlers(deps: {
  identity: DeviceIdentity;
}): GatewayRequestHandlers {
  return {
    "mesh.message.forward": async ({ params, respond }) => {
      const p = params as unknown as MeshForwardPayload;
      if (!p || !p.channel || !p.to || !p.originGatewayId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "missing required forward params (channel, to, originGatewayId)",
        });
        return;
      }

      // Loop prevention: reject if the origin is ourselves.
      if (p.originGatewayId === deps.identity.deviceId) {
        respond(false, undefined, {
          code: "LOOP_DETECTED",
          message: "message originated from this gateway; rejecting to prevent loop",
        });
        return;
      }

      // Deliver via the local outbound infrastructure.
      try {
        const { loadConfig } = await import("../../config/config.js");
        const { deliverOutboundPayloads } = await import("../../infra/outbound/deliver.js");
        const { resolveOutboundTarget } = await import("../../infra/outbound/targets.js");

        const cfg = loadConfig();
        const resolved = resolveOutboundTarget({
          channel: p.channel as ChannelId,
          to: p.to,
          cfg,
          accountId: p.accountId,
          mode: "explicit",
        });
        if (!resolved.ok) {
          respond(false, undefined, {
            code: "TARGET_RESOLUTION_FAILED",
            message: String(resolved.error),
          });
          return;
        }
        const results = await deliverOutboundPayloads({
          cfg,
          channel: p.channel as ChannelId,
          to: resolved.to,
          accountId: p.accountId,
          payloads: [
            {
              text: p.message,
              mediaUrl: p.mediaUrl,
              mediaUrls: p.mediaUrls,
            },
          ],
        });

        const last = results.at(-1);
        respond(true, {
          messageId: last?.messageId,
          channel: p.channel,
        });
      } catch (err) {
        respond(false, undefined, {
          code: "DELIVERY_FAILED",
          message: String(err),
        });
      }
    },
  };
}
