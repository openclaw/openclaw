import type { GatewayRequestHandlers } from "../../gateway/server-methods/types.js";
import { listTrustedPeers, addTrustedPeer, removeTrustedPeer } from "../peer-trust.js";

export function createMeshTrustHandlers(): GatewayRequestHandlers {
  return {
    "mesh.trust.list": async ({ respond }) => {
      const peers = await listTrustedPeers();
      respond(true, { peers });
    },

    "mesh.trust.add": async ({ params, respond }) => {
      const deviceId =
        typeof (params as { deviceId?: unknown }).deviceId === "string"
          ? (params as { deviceId: string }).deviceId.trim()
          : "";
      if (!deviceId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "deviceId is required",
        });
        return;
      }
      const displayName =
        typeof (params as { displayName?: unknown }).displayName === "string"
          ? (params as { displayName: string }).displayName.trim()
          : undefined;
      const publicKey =
        typeof (params as { publicKey?: unknown }).publicKey === "string"
          ? (params as { publicKey: string }).publicKey.trim()
          : undefined;
      const result = await addTrustedPeer({ deviceId, displayName, publicKey });
      respond(true, { added: result.added, deviceId });
    },

    "mesh.trust.remove": async ({ params, respond }) => {
      const deviceId =
        typeof (params as { deviceId?: unknown }).deviceId === "string"
          ? (params as { deviceId: string }).deviceId.trim()
          : "";
      if (!deviceId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "deviceId is required",
        });
        return;
      }
      const result = await removeTrustedPeer(deviceId);
      respond(true, { removed: result.removed, deviceId });
    },
  };
}
