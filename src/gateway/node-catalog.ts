import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import type { NodePairingPairedNode } from "../infra/node-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import type { NodeSession } from "./node-registry.js";

type KnownNodeDevicePairingSource = {
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

type KnownNodeApprovedSource = {
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

/** Normalizes node surfaces from live and durable sources into stable sorted lists. */
function uniqueSortedStrings(...items: Array<readonly unknown[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}

/** Projects paired-device records into the node catalog only after node-role proof. */
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

/** Projects approved node pairing records into the durable catalog source shape. */
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
  // Live connections are one source of last-seen data, but offline lists should
  // use the newest durable signal from node-pairing or device-pairing metadata.
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

/** Merges live session data over durable node/device pairing metadata. */
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
    // Connected nodes expose their current effective surface; offline nodes
    // fall back to the approved durable pairing surface.
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

/** Builds a lookup catalog across paired devices, approved nodes, and live sessions. */
export function createKnownNodeCatalog(params: {
  pairedDevices: readonly PairedDevice[];
  pairedNodes?: readonly NodePairingPairedNode[];
  connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog {
  // Device pairings are included only when the current effective role includes
  // node, so revoked historical node tokens do not keep stale nodes visible.
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

/** Lists known nodes with connected nodes first, then stable display-name ordering. */
export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  return [...catalog.entriesById.values()]
    .map((entry) => entry.effective)
    .toSorted(compareKnownNodes);
}

/** Returns the merged catalog entry plus its source records for diagnostics/tests. */
export function getKnownNodeEntry(
  catalog: KnownNodeCatalog,
  nodeId: string,
): KnownNodeEntry | null {
  return catalog.entriesById.get(nodeId) ?? null;
}

/** Looks up the effective node-list projection for one node id. */
export function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null {
  return getKnownNodeEntry(catalog, nodeId)?.effective ?? null;
}
