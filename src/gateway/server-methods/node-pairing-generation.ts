import {
  getPairedDevice,
  listApprovedPairedDeviceRoles,
  type PairedDevice,
} from "../../infra/device-pairing.js";

export type NodePairingGeneration = {
  nodeId: string;
  key: string;
};

function resolveNodePairingGeneration(device: PairedDevice | null): NodePairingGeneration | null {
  if (!device || !listApprovedPairedDeviceRoles(device).includes("node")) {
    return null;
  }
  const nodeApprovedAtMs = device.nodeSurface?.approvedAtMs ?? device.approvedAtMs;
  return {
    nodeId: device.deviceId,
    key: [device.publicKey, device.createdAtMs, device.approvedAtMs, nodeApprovedAtMs].join("\0"),
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
