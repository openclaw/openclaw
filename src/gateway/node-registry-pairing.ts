import type { PairedDeviceNodeBinding } from "../infra/device-pairing-node-state.js";
import type { NodeSession } from "./node-session.types.js";

export type NodePairingLease = {
  session: NodeSession & { pairingIdentity: string };
  nodeId: string;
  connId: string;
  binding: PairedDeviceNodeBinding;
};

export type NodePairingLeaseResolution<TSession = NodePairingLease["session"]> =
  | { status: "current"; session: TSession }
  | { status: "stale"; presenceInvalidated: boolean }
  | { status: "unavailable" };

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

export function resolvePublishedPairingCurrentness(
  node: { nodeId: string; pairingIdentity?: string; pairingGeneration?: string },
  isPairingStateCurrent:
    | ((nodeId: string, expected: PairedDeviceNodeBinding) => boolean)
    | undefined,
): "current" | "stale" | "unavailable" {
  if (!isPairingStateCurrent) {
    return "current";
  }
  try {
    return node.pairingIdentity &&
      isPairingStateCurrent(node.nodeId, {
        identity: node.pairingIdentity,
        ...(node.pairingGeneration ? { generation: node.pairingGeneration } : {}),
      })
      ? "current"
      : "stale";
  } catch {
    return "unavailable";
  }
}

export function isPublishedPairingCurrent(
  node: { nodeId: string; pairingIdentity?: string; pairingGeneration?: string },
  isPairingStateCurrent:
    | ((nodeId: string, expected: PairedDeviceNodeBinding) => boolean)
    | undefined,
): boolean {
  return resolvePublishedPairingCurrentness(node, isPairingStateCurrent) === "current";
}
