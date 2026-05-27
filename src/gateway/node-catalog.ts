import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import type { NodeSession } from "./node-registry.js";

export type KnownNodeCatalog = {
  pairedById: Map<string, NodeListNode>;
  connectedById: Map<string, NodeSession>;
};

function uniqueSortedStrings(...items: Array<readonly string[] | undefined>): string[] {
  const values = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    for (const value of item) {
      const trimmed = value.trim();
      if (trimmed) {
        values.add(trimmed);
      }
    }
  }
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function buildPairedNodeRecord(entry: PairedDevice): NodeListNode {
  return {
    nodeId: entry.deviceId,
    displayName: entry.displayName,
    platform: entry.platform,
    version: undefined,
    coreVersion: undefined,
    uiVersion: undefined,
    clientId: entry.clientId,
    clientMode: entry.clientMode,
    deviceFamily: undefined,
    modelIdentifier: undefined,
    remoteIp: entry.remoteIp,
    caps: [],
    commands: [],
    permissions: undefined,
    approvedAtMs: entry.approvedAtMs,
    paired: true,
    connected: false,
  };
}

function buildKnownNodeEntry(params: {
  nodeId: string;
  paired?: NodeListNode;
  live?: NodeSession;
}): NodeListNode {
  const { nodeId, paired, live } = params;
  return {
    nodeId,
    displayName: live?.displayName ?? paired?.displayName,
    platform: live?.platform ?? paired?.platform,
    version: live?.version ?? paired?.version,
    coreVersion: live?.coreVersion ?? paired?.coreVersion,
    uiVersion: live?.uiVersion ?? paired?.uiVersion,
    clientId: live?.clientId ?? paired?.clientId,
    clientMode: live?.clientMode ?? paired?.clientMode,
    deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
    modelIdentifier: live?.modelIdentifier ?? paired?.modelIdentifier,
    remoteIp: live?.remoteIp ?? paired?.remoteIp,
    caps: uniqueSortedStrings(live?.caps, paired?.caps),
    commands: uniqueSortedStrings(live?.commands, paired?.commands),
    pathEnv: live?.pathEnv,
    permissions: live?.permissions ?? paired?.permissions,
    connectedAtMs: live?.connectedAtMs,
    approvedAtMs: paired?.approvedAtMs,
    paired: Boolean(paired),
    connected: Boolean(live),
  };
}

function compareKnownNodes(left: NodeListNode, right: NodeListNode): number {
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  const leftName = (left.displayName ?? left.nodeId).toLowerCase();
  const rightName = (right.displayName ?? right.nodeId).toLowerCase();
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return left.nodeId.localeCompare(right.nodeId);
}

export function createKnownNodeCatalog(params: {
  pairedDevices: readonly PairedDevice[];
  connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog {
  const pairedById = new Map(
    params.pairedDevices
      .filter((entry) => hasEffectivePairedDeviceRole(entry, "node"))
      .map((entry) => [entry.deviceId, buildPairedNodeRecord(entry)]),
  );
  const connectedById = new Map(params.connectedNodes.map((entry) => [entry.nodeId, entry]));
  return { pairedById, connectedById };
}

export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  const nodeIds = new Set<string>([...catalog.pairedById.keys(), ...catalog.connectedById.keys()]);
  return [...nodeIds]
    .map((nodeId) =>
      buildKnownNodeEntry({
        nodeId,
        paired: catalog.pairedById.get(nodeId),
        live: catalog.connectedById.get(nodeId),
      }),
    )
    .toSorted(compareKnownNodes);
}

export function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null {
  const paired = catalog.pairedById.get(nodeId);
  const live = catalog.connectedById.get(nodeId);
  if (!paired && !live) {
    return null;
  }
  return buildKnownNodeEntry({ nodeId, paired, live });
}
