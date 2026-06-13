// Gateway node id resolution keeps the user-visible node-host id separate from
// the cryptographic device id that authenticates the connecting process.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";

function normalizeNodeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isNodeHostConnect(connect: Pick<ConnectParams, "client">): boolean {
  return (
    connect.client.id === GATEWAY_CLIENT_IDS.NODE_HOST &&
    connect.client.mode === GATEWAY_CLIENT_MODES.NODE
  );
}

export function resolveNodeConnectId(connect: ConnectParams): string {
  const explicitNodeId = normalizeNodeId(connect.nodeId);
  if (explicitNodeId && isNodeHostConnect(connect) && resolveNodeConnectDeviceId(connect)) {
    return explicitNodeId;
  }
  return normalizeNodeId(connect.device?.id) ?? connect.client.id;
}

export function resolveNodeConnectDeviceId(connect: ConnectParams): string | null {
  return normalizeNodeId(connect.device?.id) ?? null;
}

export function nodePairingMatchesConnectDevice(
  pairedNode: { nodeId: string; deviceId?: string },
  connect: ConnectParams,
): boolean {
  const deviceId = resolveNodeConnectDeviceId(connect);
  const pairedDeviceId = normalizeNodeId(pairedNode.deviceId);
  if (!deviceId) {
    return !pairedDeviceId && pairedNode.nodeId === resolveNodeConnectId(connect);
  }
  return pairedDeviceId ? pairedDeviceId === deviceId : pairedNode.nodeId === deviceId;
}

export function resolveClientNodeId(
  client: { connect?: ConnectParams } | null | undefined,
): string | null {
  return client?.connect ? resolveNodeConnectId(client.connect) : null;
}
