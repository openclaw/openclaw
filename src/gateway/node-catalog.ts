import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import type { NodePairingPairedNode } from "../infra/node-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { NodeSession } from "./node-registry.js";

export type KnownNodeDevicePairingSource = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  approvedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

export type KnownNodeApprovedSource = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  approvedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

export type KnownNodeEntry = {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
  effective: NodeListNode;
};

export type KnownNodeCatalog = {
  entriesById: Map<string, KnownNodeEntry>;
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

function buildDevicePairingSource(entry: PairedDevice): KnownNodeDevicePairingSource {
  return {
    nodeId: entry.deviceId,
    displayName: entry.displayName,
    platform: entry.platform,
    clientId: entry.clientId,
    clientMode: entry.clientMode,
    remoteIp: entry.remoteIp,
    approvedAtMs: entry.approvedAtMs,
    lastSeenAtMs: entry.lastSeenAtMs,
    lastSeenReason: entry.lastSeenReason,
  };
}

function buildApprovedNodeSource(entry: NodePairingPairedNode): KnownNodeApprovedSource {
  return {
    nodeId: entry.nodeId,
    displayName: entry.displayName,
    platform: entry.platform,
    version: entry.version,
    coreVersion: entry.coreVersion,
    uiVersion: entry.uiVersion,
    remoteIp: entry.remoteIp,
    deviceFamily: entry.deviceFamily,
    modelIdentifier: entry.modelIdentifier,
    caps: entry.caps ?? [],
    commands: entry.commands ?? [],
    permissions: entry.permissions,
    approvedAtMs: entry.approvedAtMs,
    lastSeenAtMs: entry.lastSeenAtMs,
    lastSeenReason: entry.lastSeenReason,
  };
}

function resolveEffectiveLastSeen(entry: {
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
}): Pick<NodeListNode, "lastSeenAtMs" | "lastSeenReason"> {
  const { devicePairing, nodePairing, live } = entry;
  const candidates = [
    live?.connectedAtMs ? { ts: live.connectedAtMs, reason: "connect" } : null,
    nodePairing?.lastSeenAtMs
      ? { ts: nodePairing.lastSeenAtMs, reason: nodePairing.lastSeenReason }
      : null,
    devicePairing?.lastSeenAtMs
      ? { ts: devicePairing.lastSeenAtMs, reason: devicePairing.lastSeenReason }
      : null,
  ].filter((candidate) => candidate !== null);
  const winner = candidates.reduce<{
    ts: number;
    reason?: string;
  } | null>((best, candidate) => {
    if (!candidate) {
      return best;
    }
    if (!best || candidate.ts > best.ts) {
      return candidate;
    }
    return best;
  }, null);
  return {
    lastSeenAtMs: winner?.ts,
    lastSeenReason: winner?.reason,
  };
}

function buildEffectiveKnownNode(entry: {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
}): NodeListNode {
  const { nodeId, devicePairing, nodePairing, live } = entry;
  const { lastSeenAtMs, lastSeenReason } = resolveEffectiveLastSeen(entry);
  return {
    nodeId,
    displayName: live?.displayName ?? nodePairing?.displayName ?? devicePairing?.displayName,
    platform: live?.platform ?? nodePairing?.platform ?? devicePairing?.platform,
    version: live?.version ?? nodePairing?.version,
    coreVersion: live?.coreVersion ?? nodePairing?.coreVersion,
    uiVersion: live?.uiVersion ?? nodePairing?.uiVersion,
    clientId: live?.clientId ?? devicePairing?.clientId,
    clientMode: live?.clientMode ?? devicePairing?.clientMode,
    deviceFamily: live?.deviceFamily ?? nodePairing?.deviceFamily,
    modelIdentifier: live?.modelIdentifier ?? nodePairing?.modelIdentifier,
    remoteIp: live?.remoteIp ?? nodePairing?.remoteIp ?? devicePairing?.remoteIp,
    caps: live ? uniqueSortedStrings(live.caps) : uniqueSortedStrings(nodePairing?.caps),
    commands: live
      ? uniqueSortedStrings(live.commands)
      : uniqueSortedStrings(nodePairing?.commands),
    pathEnv: live?.pathEnv,
    permissions: live?.permissions ?? nodePairing?.permissions,
    connectedAtMs: live?.connectedAtMs,
    approvedAtMs: nodePairing?.approvedAtMs ?? devicePairing?.approvedAtMs,
    lastSeenAtMs,
    lastSeenReason,
    paired: Boolean(devicePairing ?? nodePairing),
    connected: Boolean(live),
  };
}

function compareKnownNodes(left: NodeListNode, right: NodeListNode): number {
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  const leftName = normalizeLowercaseStringOrEmpty(left.displayName ?? left.nodeId);
  const rightName = normalizeLowercaseStringOrEmpty(right.displayName ?? right.nodeId);
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
  pairedNodes?: readonly NodePairingPairedNode[];
  connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog {
  const devicePairingById = new Map(
    params.pairedDevices
      .filter((entry) => hasEffectivePairedDeviceRole(entry, "node"))
      .map((entry) => [entry.deviceId, buildDevicePairingSource(entry)]),
  );
  const nodePairingById = new Map(
    (params.pairedNodes ?? []).map((entry) => [entry.nodeId, buildApprovedNodeSource(entry)]),
  );
  const liveById = new Map(params.connectedNodes.map((entry) => [entry.nodeId, entry]));
  const nodeIds = new Set<string>([
    ...devicePairingById.keys(),
    ...nodePairingById.keys(),
    ...liveById.keys(),
  ]);
  const entriesById = new Map<string, KnownNodeEntry>();
  for (const nodeId of nodeIds) {
    const devicePairing = devicePairingById.get(nodeId);
    const nodePairing = nodePairingById.get(nodeId);
    const live = liveById.get(nodeId);
    entriesById.set(nodeId, {
      nodeId,
      devicePairing,
      nodePairing,
      live,
      effective: buildEffectiveKnownNode({
        nodeId,
        devicePairing,
        nodePairing,
        live,
      }),
    });
  }
  return { entriesById };
}

export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  return [...catalog.entriesById.values()]
    .map((entry) => entry.effective)
    .toSorted(compareKnownNodes);
}

export function getKnownNodeEntry(
  catalog: KnownNodeCatalog,
  nodeId: string,
): KnownNodeEntry | null {
  return catalog.entriesById.get(nodeId) ?? null;
}

export function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null {
  return getKnownNodeEntry(catalog, nodeId)?.effective ?? null;
}
