// Gateway node catalog builder.
// Merges paired devices, approved node records, and live websocket sessions.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import type { NodePairingPairedNode } from "../infra/node-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import type { NodeSession } from "./node-registry.js";

type KnownNodeDevicePairingSource = {
  nodeId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  approvedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

type KnownNodeApprovedSource = {
  nodeId: string;
  deviceId?: string;
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
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

type KnownNodeEntry = {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
  effective: NodeListNode;
};

type KnownNodeCatalog = {
  entriesById: Map<string, KnownNodeEntry>;
};

function uniqueSortedStrings(...items: Array<readonly unknown[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}

function buildDevicePairingSource(entry: PairedDevice): KnownNodeDevicePairingSource {
  return {
    nodeId: entry.deviceId,
    deviceId: entry.deviceId,
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
    deviceId: entry.deviceId,
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
    lastConnectedAtMs: entry.lastConnectedAtMs,
    lastSeenAtMs: entry.lastSeenAtMs,
    lastSeenReason: entry.lastSeenReason,
  };
}

function resolveEffectiveLastSeen(params: {
  live?: NodeSession;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
}): { lastSeenAtMs?: number; lastSeenReason?: string } {
  // Live connected time is the freshest signal; stored last-seen values fill in
  // disconnected rows without letting stale device-pairing data override nodes.
  const candidates: Array<{ atMs: number; reason?: string }> = [
    params.live?.connectedAtMs ? { atMs: params.live.connectedAtMs, reason: "connect" } : undefined,
    params.nodePairing?.lastSeenAtMs
      ? { atMs: params.nodePairing.lastSeenAtMs, reason: params.nodePairing.lastSeenReason }
      : undefined,
    params.nodePairing?.lastConnectedAtMs
      ? { atMs: params.nodePairing.lastConnectedAtMs, reason: "connect" }
      : undefined,
    params.devicePairing?.lastSeenAtMs
      ? { atMs: params.devicePairing.lastSeenAtMs, reason: params.devicePairing.lastSeenReason }
      : undefined,
  ].filter((entry) => entry !== undefined);
  let newest: { atMs: number; reason?: string } | undefined;
  for (const candidate of candidates) {
    if (!newest || candidate.atMs > newest.atMs) {
      newest = candidate;
    }
  }
  if (!newest) {
    return {};
  }
  return {
    lastSeenAtMs: newest.atMs,
    lastSeenReason: newest.reason,
  };
}

function buildEffectiveKnownNode(entry: {
  nodeId: string;
  devicePairing?: KnownNodeDevicePairingSource;
  nodePairing?: KnownNodeApprovedSource;
  live?: NodeSession;
}): NodeListNode {
  const { nodeId, devicePairing, nodePairing, live } = entry;
  const lastSeen = resolveEffectiveLastSeen({ live, devicePairing, nodePairing });
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
    lastSeenAtMs: lastSeen.lastSeenAtMs,
    lastSeenReason: lastSeen.lastSeenReason,
    approvedAtMs: nodePairing?.approvedAtMs ?? devicePairing?.approvedAtMs,
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

function normalizeOptionalNodeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function addDeviceNodeAlias(
  aliases: Map<string, string>,
  params: { deviceId?: string; nodeId: string; overwrite: boolean },
): void {
  const deviceId = normalizeOptionalNodeId(params.deviceId);
  const nodeId = normalizeOptionalNodeId(params.nodeId);
  if (!deviceId || !nodeId || deviceId === nodeId || (!params.overwrite && aliases.has(deviceId))) {
    return;
  }
  aliases.set(deviceId, nodeId);
}

function buildDeviceNodeAliases(params: {
  pairedNodes: readonly NodePairingPairedNode[];
  connectedNodes: readonly NodeSession[];
}): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of params.connectedNodes) {
    addDeviceNodeAlias(aliases, {
      deviceId: entry.deviceId,
      nodeId: entry.nodeId,
      overwrite: false,
    });
  }
  for (const entry of params.pairedNodes) {
    addDeviceNodeAlias(aliases, {
      deviceId: entry.deviceId,
      nodeId: entry.nodeId,
      overwrite: true,
    });
  }
  return aliases;
}

function isStaleLiveDeviceAlias(
  entry: NodeSession,
  aliasesByDeviceId: ReadonlyMap<string, string>,
): boolean {
  const deviceId = normalizeOptionalNodeId(entry.deviceId);
  return Boolean(deviceId && entry.nodeId === deviceId && aliasesByDeviceId.has(deviceId));
}

/** Builds a node catalog keyed by node id from pairing stores and live sessions. */
export function createKnownNodeCatalog(params: {
  pairedDevices: readonly PairedDevice[];
  pairedNodes?: readonly NodePairingPairedNode[];
  connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog {
  const pairedNodes = params.pairedNodes ?? [];
  const aliasesByDeviceId = buildDeviceNodeAliases({
    pairedNodes,
    connectedNodes: params.connectedNodes,
  });
  const devicePairingById = new Map<string, KnownNodeDevicePairingSource>();
  for (const entry of params.pairedDevices) {
    if (!hasEffectivePairedDeviceRole(entry, "node")) {
      continue;
    }
    devicePairingById.set(
      aliasesByDeviceId.get(entry.deviceId) ?? entry.deviceId,
      buildDevicePairingSource(entry),
    );
  }
  const nodePairingById = new Map(
    pairedNodes.map((entry) => [entry.nodeId, buildApprovedNodeSource(entry)]),
  );
  const liveById = new Map(
    params.connectedNodes
      .filter((entry) => !isStaleLiveDeviceAlias(entry, aliasesByDeviceId))
      .map((entry) => [entry.nodeId, entry]),
  );
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

/** Lists known nodes with connected nodes first and deterministic display ordering. */
export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  return [...catalog.entriesById.values()]
    .map((entry) => entry.effective)
    .toSorted(compareKnownNodes);
}

/** Returns the merged catalog entry for diagnostics that need source details. */
export function getKnownNodeEntry(
  catalog: KnownNodeCatalog,
  nodeId: string,
): KnownNodeEntry | null {
  return catalog.entriesById.get(nodeId) ?? null;
}

/** Returns the effective node row shown to gateway clients. */
export function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null {
  return getKnownNodeEntry(catalog, nodeId)?.effective ?? null;
}
