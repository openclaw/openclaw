import { randomUUID } from "node:crypto";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import { resolveNodePairingGeneration } from "./device-pairing-identity.js";
import type { PairedDevice, PairedDevicePendingNodeSurface } from "./device-pairing.types.js";
import { type NodeApprovalScope, resolveNodePairApprovalScopes } from "./node-pairing-authz.js";
import { sameNodeApprovalSurfaceSet, sameNodePermissionSurface } from "./node-pairing-surface.js";

type NodeDeclaredSurface = {
  nodeId: string;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
};

/** Node-declared pairing surface before approval. */
export type NodePairingRequestInput = NodeDeclaredSurface & {
  silent?: boolean;
};

/** Pending node pairing request awaiting operator approval. */
export type NodePairingPendingRequest = NodePairingRequestInput & {
  requestId: string;
  requiredApproveScopes: NodeApprovalScope[];
  ts: number;
};

export type NodePairingPendingSnapshot = Pick<NodePairingPendingRequest, "requestId" | "nodeId"> & {
  revision?: string;
};

/** Opaque claim preventing approval while a reconnect resolves stale pending state. */
export type NodePairingCleanupClaim = {
  baseDir: string | undefined;
  generation: number;
  nodeId: string;
  observed: NodePairingPendingSnapshot;
};

/** Pending request summary returned when a new approval surface supersedes older requests. */
export type NodePairingSupersededRequest = Pick<NodePairingPendingRequest, "requestId" | "nodeId">;

/** Result for creating or refreshing a pending node pairing request. */
export type RequestNodePairingResult = {
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
  superseded?: NodePairingSupersededRequest[];
};

/** Approved node record projected from the device's node surface (no auth material). */
export type PairedDeviceNode = NodeDeclaredSurface & {
  bins?: string[];
  sessionHost?: boolean;
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
  lastDisconnectedAtMs?: number;
  lastHostStats?: NodeHostStats;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

export type NodePairingList = {
  pending: NodePairingPendingRequest[];
  paired: PairedDeviceNode[];
};

export type NodePairingListWithGeneration = Omit<NodePairingList, "paired"> & {
  paired: Array<PairedDeviceNode & { pairingGeneration?: string }>;
};

type ApprovedNodePairingResult = {
  requestId: string;
  node: PairedDeviceNode;
  pairingIdentity: string;
  nextPairingGeneration: string;
  previousPairingGeneration?: string;
};
type ForbiddenNodePairingResult = { status: "forbidden"; missingScope: string };
export type ApproveNodePairingResult =
  | ApprovedNodePairingResult
  | ForbiddenNodePairingResult
  | null;

export type RecordPairedNodeConnectionResult =
  | { recorded: false }
  | { recorded: true; firstConnection: boolean };

export function toPublicPendingRequest(
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): NodePairingPendingRequest {
  return {
    requestId: pending.requestId,
    nodeId: device.deviceId,
    clientId: pending.clientId ?? device.clientId,
    clientMode: pending.clientMode ?? device.clientMode,
    displayName: pending.displayName ?? device.displayName,
    platform: pending.platform ?? device.platform,
    version: pending.version,
    coreVersion: pending.coreVersion,
    uiVersion: pending.uiVersion,
    deviceFamily: pending.deviceFamily ?? device.deviceFamily,
    modelIdentifier: pending.modelIdentifier,
    caps: pending.caps,
    commands: pending.commands,
    requiredApproveScopes: resolveNodePairApprovalScopes(pending.commands ?? []),
    permissions: pending.permissions,
    remoteIp: pending.remoteIp ?? device.remoteIp,
    silent: pending.silent,
    ts: pending.ts,
  };
}

export function toPendingSnapshot(
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): NodePairingPendingSnapshot {
  return {
    requestId: pending.requestId,
    nodeId: device.deviceId,
    ...(pending.revision ? { revision: pending.revision } : {}),
  };
}

export function toPairedNode(
  device: PairedDevice,
  options?: { includePairingGeneration?: boolean },
): PairedDeviceNode | null {
  const surface = device.nodeSurface;
  if (!surface) {
    return null;
  }
  const pairingGeneration = options?.includePairingGeneration
    ? resolveNodePairingGeneration(device)?.key
    : undefined;
  return {
    nodeId: device.deviceId,
    clientId: device.clientId,
    clientMode: device.clientMode,
    // The surface name is the operator-facing node name (approval snapshot or
    // node.rename); reconnect metadata refreshes only touch the device name.
    displayName: surface.displayName ?? device.displayName,
    platform: device.platform,
    version: surface.version,
    coreVersion: surface.coreVersion,
    uiVersion: surface.uiVersion,
    deviceFamily: device.deviceFamily,
    modelIdentifier: surface.modelIdentifier,
    caps: surface.caps,
    commands: surface.commands,
    permissions: surface.permissions,
    remoteIp: device.remoteIp,
    bins: surface.bins,
    ...(surface.sessionHost === true ? { sessionHost: true } : {}),
    ...(pairingGeneration ? { pairingGeneration } : {}),
    createdAtMs: surface.createdAtMs,
    approvedAtMs: surface.approvedAtMs,
    lastConnectedAtMs: surface.lastConnectedAtMs,
    lastDisconnectedAtMs: surface.lastDisconnectedAtMs,
    lastHostStats: surface.lastHostStats,
    lastSeenAtMs: device.lastSeenAtMs,
    lastSeenReason: device.lastSeenReason,
  };
}

export function buildPendingNodeSurface(params: {
  req: NodePairingRequestInput;
  nowMs: number;
}): PairedDevicePendingNodeSurface {
  return {
    requestId: randomUUID(),
    revision: randomUUID(),
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    displayName: params.req.displayName,
    platform: params.req.platform,
    version: params.req.version,
    coreVersion: params.req.coreVersion,
    uiVersion: params.req.uiVersion,
    deviceFamily: params.req.deviceFamily,
    modelIdentifier: params.req.modelIdentifier,
    caps: normalizeArrayBackedTrimmedStringList(params.req.caps),
    commands: normalizeArrayBackedTrimmedStringList(params.req.commands),
    permissions: params.req.permissions,
    remoteIp: params.req.remoteIp,
    silent: params.req.silent,
    ts: params.nowMs,
  };
}

export function refreshPendingNodeSurface(
  existing: PairedDevicePendingNodeSurface,
  incoming: NodePairingRequestInput,
  nowMs: number,
): PairedDevicePendingNodeSurface {
  return {
    ...existing,
    revision: randomUUID(),
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    version: incoming.version ?? existing.version,
    coreVersion: incoming.coreVersion ?? existing.coreVersion,
    uiVersion: incoming.uiVersion ?? existing.uiVersion,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    modelIdentifier: incoming.modelIdentifier ?? existing.modelIdentifier,
    caps: normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps,
    commands: normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands,
    permissions: incoming.permissions ?? existing.permissions,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // Preserve interactive visibility if either request needs attention.
    silent: Boolean(existing.silent && incoming.silent),
    ts: nowMs,
  };
}

export function samePendingApprovalSurface(
  existing: PairedDevicePendingNodeSurface,
  incoming: NodePairingRequestInput,
): boolean {
  const incomingCaps = normalizeArrayBackedTrimmedStringList(incoming.caps) ?? existing.caps;
  const incomingCommands =
    normalizeArrayBackedTrimmedStringList(incoming.commands) ?? existing.commands;
  const incomingPermissions = incoming.permissions ?? existing.permissions;
  return (
    // Metadata-only reconnects may refresh one pending request; approval-surface changes supersede.
    sameNodeApprovalSurfaceSet(existing.caps, incomingCaps) &&
    sameNodeApprovalSurfaceSet(existing.commands, incomingCommands) &&
    sameNodePermissionSurface(existing.permissions, incomingPermissions)
  );
}

export function samePendingReconnectMetadata(
  existing: PairedDevicePendingNodeSurface,
  incoming: NodePairingRequestInput,
): boolean {
  return (
    (incoming.clientId ?? existing.clientId) === existing.clientId &&
    (incoming.clientMode ?? existing.clientMode) === existing.clientMode &&
    (incoming.displayName ?? existing.displayName) === existing.displayName &&
    (incoming.platform ?? existing.platform) === existing.platform &&
    (incoming.version ?? existing.version) === existing.version &&
    (incoming.coreVersion ?? existing.coreVersion) === existing.coreVersion &&
    (incoming.uiVersion ?? existing.uiVersion) === existing.uiVersion &&
    (incoming.deviceFamily ?? existing.deviceFamily) === existing.deviceFamily &&
    (incoming.modelIdentifier ?? existing.modelIdentifier) === existing.modelIdentifier &&
    (incoming.remoteIp ?? existing.remoteIp) === existing.remoteIp &&
    Boolean(existing.silent && incoming.silent) === Boolean(existing.silent)
  );
}

/** Project node pairing state from an already-loaded device pairing snapshot. */
export function projectNodePairing(
  pairedDevices: readonly PairedDevice[],
  options?: { includePairingGeneration?: boolean },
): NodePairingListWithGeneration {
  const pending: NodePairingPendingRequest[] = [];
  const paired: PairedDeviceNode[] = [];
  for (const device of pairedDevices) {
    if (device.pendingNodeSurface) {
      pending.push(toPublicPendingRequest(device, device.pendingNodeSurface));
    }
    const node = toPairedNode(device, options);
    if (node) {
      paired.push(node);
    }
  }
  pending.sort((a, b) => b.ts - a.ts);
  paired.sort((a, b) => b.approvedAtMs - a.approvedAtMs);
  return { pending, paired };
}
