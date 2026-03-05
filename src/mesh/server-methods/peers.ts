import type { GatewayRequestHandlers } from "../../gateway/server-methods/types.js";
import type { MeshCapabilityRegistry } from "../capabilities.js";
import type { PeerRegistry } from "../peer-registry.js";

export function createMeshPeersHandlers(deps: {
  peerRegistry: PeerRegistry;
  capabilityRegistry: MeshCapabilityRegistry;
  localDeviceId: string;
}): GatewayRequestHandlers {
  return {
    "mesh.peers": async ({ respond }) => {
      const peers = deps.peerRegistry.listConnected().map((p) => ({
        deviceId: p.deviceId,
        displayName: p.displayName,
        outbound: p.outbound,
        capabilities: p.capabilities,
        connectedAtMs: p.connectedAtMs,
      }));
      respond(true, { peers });
    },

    "mesh.status": async ({ respond }) => {
      const connected = deps.peerRegistry.listConnected();
      respond(true, {
        localDeviceId: deps.localDeviceId,
        connectedPeers: connected.length,
        peers: connected.map((p) => ({
          deviceId: p.deviceId,
          displayName: p.displayName,
          outbound: p.outbound,
          connectedAtMs: p.connectedAtMs,
        })),
      });
    },
  };
}
