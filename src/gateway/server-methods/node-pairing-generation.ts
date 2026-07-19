import { createHash } from "node:crypto";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  type PairedDevice,
} from "../../infra/device-pairing.js";

export type NodePairingGeneration = {
  nodeId: string;
  key: string;
};

function resolveNodePairingGeneration(device: PairedDevice | null): NodePairingGeneration | null {
  if (!device || !hasEffectivePairedDeviceRole(device, "node") || !device.nodeSurface) {
    return null;
  }
  const nodeToken = device.tokens?.node;
  const nodeSurface = device.nodeSurface;
  // Only node-owned identity participates here. Device-wide approval time also
  // changes for unrelated operator upgrades and would invalidate valid node work.
  const key = createHash("sha256")
    .update(
      [
        device.publicKey,
        device.createdAtMs,
        nodeToken?.token ?? "",
        nodeToken?.revokedAtMs ?? "",
        nodeSurface?.createdAtMs ?? "",
        nodeSurface?.approvedAtMs ?? "",
      ].join("\0"),
    )
    .digest("hex");
  return {
    nodeId: device.deviceId,
    key,
  };
}

/** Captures the persistent node pairing generation admitted for new work. */
export async function captureNodePairingGeneration(
  nodeId: string,
): Promise<NodePairingGeneration | null> {
  return resolveNodePairingGeneration(await getPairedDevice(nodeId));
}

/** Revalidates that asynchronous work still belongs to the admitted pairing. */
export async function isNodePairingGenerationCurrent(
  generation: NodePairingGeneration,
): Promise<boolean> {
  const current = resolveNodePairingGeneration(await getPairedDevice(generation.nodeId));
  return current?.key === generation.key;
}
