import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { MeshCapabilityRegistry } from "./capabilities.js";

export type MeshRouteResult =
  | { kind: "local" }
  | { kind: "mesh"; peerDeviceId: string }
  | { kind: "unavailable" };

/**
 * Resolve where to send a message for a given channel.
 * Checks local availability first, falls back to mesh peer with matching capability.
 */
export function resolveMeshRoute(params: {
  channel: string;
  capabilityRegistry: MeshCapabilityRegistry;
}): MeshRouteResult {
  // Check if the channel is available locally.
  const plugin = getChannelPlugin(params.channel as ChannelId);
  if (plugin) {
    return { kind: "local" };
  }

  // Check mesh peers for the channel capability.
  const peerDeviceId = params.capabilityRegistry.findPeerWithChannel(params.channel);
  if (peerDeviceId) {
    return { kind: "mesh", peerDeviceId };
  }

  return { kind: "unavailable" };
}
