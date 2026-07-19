import {
  getPairedDevice,
  resolveNodePairingGeneration,
  type NodePairingGeneration,
} from "../../infra/device-pairing.js";

export type { NodePairingGeneration } from "../../infra/device-pairing.js";

/** Captures the persistent node pairing generation admitted for new work. */
export async function captureNodePairingGeneration(
  nodeId: string,
): Promise<NodePairingGeneration | null> {
  return resolveNodePairingGeneration(await getPairedDevice(nodeId));
}

/** Binds a connected session to the exact device key and node token it authenticated with. */
export async function captureAuthenticatedNodePairingGeneration(params: {
  nodeId: string;
  publicKey: string;
  token: string;
  baseDir?: string;
}): Promise<NodePairingGeneration | null> {
  const device = await getPairedDevice(params.nodeId, params.baseDir);
  if (device?.publicKey !== params.publicKey || device.tokens?.node?.token !== params.token) {
    return null;
  }
  return resolveNodePairingGeneration(device);
}

/** Revalidates that asynchronous work still belongs to the admitted pairing. */
export async function isNodePairingGenerationCurrent(
  generation: NodePairingGeneration,
): Promise<boolean> {
  const current = resolveNodePairingGeneration(await getPairedDevice(generation.nodeId));
  return current?.key === generation.key;
}
