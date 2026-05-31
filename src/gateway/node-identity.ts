import { GATEWAY_CLIENT_MODES } from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { NodePairingPairedNode } from "../infra/node-pairing.js";

function normalizeNodeIdentityPart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveConnectNodeId(connect: ConnectParams): string {
  return resolveConnectNodeIdCandidates(connect)[0] ?? connect.client.id;
}

export function resolveConnectNodeIdCandidates(connect: ConnectParams): string[] {
  const candidates: string[] = [];
  if (connect.client.mode === GATEWAY_CLIENT_MODES.NODE) {
    const instanceId = normalizeNodeIdentityPart(connect.client.instanceId);
    if (instanceId) {
      candidates.push(instanceId);
    }
  }
  const deviceId = normalizeNodeIdentityPart(connect.device?.id);
  if (deviceId && !candidates.includes(deviceId)) {
    candidates.push(deviceId);
  }
  if (!candidates.includes(connect.client.id)) {
    candidates.push(connect.client.id);
  }
  return candidates;
}

export function nodePairingMatchesConnectDevice(params: {
  connect: ConnectParams;
  pairedNode: NodePairingPairedNode;
}): boolean {
  const deviceId = normalizeNodeIdentityPart(params.connect.device?.id);
  if (!deviceId) {
    return params.pairedNode.deviceId === undefined;
  }
  // A stable instance id is client supplied. It can carry an approved command
  // surface only while bound to the verified device identity that earned it.
  // A changed device id must re-pair unless the node proves a separate token.
  if (params.pairedNode.deviceId) {
    return params.pairedNode.deviceId === deviceId;
  }
  return params.pairedNode.nodeId === deviceId;
}
