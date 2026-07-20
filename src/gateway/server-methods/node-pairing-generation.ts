import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  resolveNodePairingGeneration,
  resolveNodePairingState,
  type NodePairingGeneration,
  type NodePairingState,
} from "../../infra/device-pairing.js";

export type {
  NodePairingGeneration,
  NodePairingIdentity,
  NodePairingState,
} from "../../infra/device-pairing.js";

/** Captures the persistent authenticated pairing and optional approved surface. */
export async function captureNodePairingState(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingState | null> {
  return resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
}

/** Captures the persistent node pairing generation admitted for new work. */
export async function captureNodePairingGeneration(
  nodeId: string,
): Promise<NodePairingGeneration | null> {
  return (await captureNodePairingState(nodeId))?.generation ?? null;
}

/** Binds a connected session to the exact device key and node token it authenticated with. */
export async function captureAuthenticatedNodePairingState(params: {
  nodeId: string;
  publicKey: string;
  token: string;
  baseDir?: string;
}): Promise<NodePairingState | null> {
  const device = await getPairedDevice(params.nodeId, params.baseDir);
  if (
    !device ||
    device.publicKey !== params.publicKey ||
    device.tokens?.node?.token !== params.token ||
    !hasEffectivePairedDeviceRole(device, "node")
  ) {
    return null;
  }
  return resolveNodePairingState(device);
}

/** Binds approved node work to the exact device key and node token used for authentication. */
export async function captureAuthenticatedNodePairingGeneration(params: {
  nodeId: string;
  publicKey: string;
  token: string;
  baseDir?: string;
}): Promise<NodePairingGeneration | null> {
  return (await captureAuthenticatedNodePairingState(params))?.generation ?? null;
}

/** Revalidates that asynchronous work still belongs to the admitted pairing. */
export async function isNodePairingGenerationCurrent(
  generation: NodePairingGeneration,
): Promise<boolean> {
  const current = resolveNodePairingGeneration(await getPairedDevice(generation.nodeId));
  return current?.key === generation.key;
}
