import type { PairedDeviceNodeBinding } from "../infra/device-pairing-node-state.js";

export function pairingBindingForSession(node: {
  pairingIdentity: string;
  pairingGeneration?: string;
}): PairedDeviceNodeBinding {
  return {
    identity: node.pairingIdentity,
    ...(node.pairingGeneration ? { generation: node.pairingGeneration } : {}),
  };
}

export function pairingStateMatchesBinding(
  binding: PairedDeviceNodeBinding,
  current: PairedDeviceNodeBinding | undefined,
): boolean {
  if (!current) {
    return false;
  }
  if (binding.identity !== current.identity) {
    return false;
  }
  return !binding.generation || binding.generation === current.generation;
}

export function isPublishedPairingCurrent(
  node: { nodeId: string; pairingIdentity?: string; pairingGeneration?: string },
  isPairingStateCurrent:
    | ((nodeId: string, expected: PairedDeviceNodeBinding) => boolean)
    | undefined,
): boolean {
  if (!isPairingStateCurrent) {
    return true;
  }
  try {
    return Boolean(
      node.pairingIdentity &&
      isPairingStateCurrent(node.nodeId, {
        identity: node.pairingIdentity,
        ...(node.pairingGeneration ? { generation: node.pairingGeneration } : {}),
      }),
    );
  } catch {
    return false;
  }
}
