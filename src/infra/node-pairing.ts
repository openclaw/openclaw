import { randomUUID } from "node:crypto";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";
import {
  deletePendingNodePairingFromDb,
  getPairedNodeFromDb,
  getPairedNodesFromDb,
  getPendingNodePairingByNodeIdFromDb,
  getPendingNodePairingFromDb,
  getPendingNodePairingsFromDb,
  upsertPairedNodeInDb,
  upsertPendingNodePairingInDb,
} from "./state-db/node-pairing-sqlite.js";

type NodePairingNodeMetadata = {
  nodeId: string;
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

export type NodePairingPendingRequest = NodePairingNodeMetadata & {
  requestId: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type NodePairingPairedNode = Omit<NodePairingNodeMetadata, "requestId"> & {
  token: string;
  bins?: string[];
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
};

export type NodePairingList = {
  pending: NodePairingPendingRequest[];
  paired: NodePairingPairedNode[];
};

const PENDING_TTL_MS = 5 * 60 * 1000;

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function newToken() {
  return generatePairingToken();
}

function pruneExpiredPending(): void {
  const now = Date.now();
  for (const req of getPendingNodePairingsFromDb()) {
    if (now - req.ts > PENDING_TTL_MS) {
      deletePendingNodePairingFromDb(req.requestId);
    }
  }
}

export async function listNodePairing(): Promise<NodePairingList> {
  pruneExpiredPending();
  const pending = getPendingNodePairingsFromDb().toSorted((a, b) => b.ts - a.ts);
  const paired = getPairedNodesFromDb().toSorted((a, b) => b.approvedAtMs - a.approvedAtMs);
  return { pending, paired };
}

export async function getPairedNode(nodeId: string): Promise<NodePairingPairedNode | null> {
  return getPairedNodeFromDb(normalizeNodeId(nodeId));
}

export async function requestNodePairing(
  req: Omit<NodePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): Promise<{
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
}> {
  pruneExpiredPending();
  const nodeId = normalizeNodeId(req.nodeId);
  if (!nodeId) {
    throw new Error("nodeId required");
  }
  const isRepair = getPairedNodeFromDb(nodeId) != null;
  const existing = getPendingNodePairingByNodeIdFromDb(nodeId);
  if (existing) {
    // Merge incoming metadata onto existing pending request
    const merged: NodePairingPendingRequest = {
      ...existing,
      displayName: req.displayName ?? existing.displayName,
      platform: req.platform ?? existing.platform,
      version: req.version ?? existing.version,
      coreVersion: req.coreVersion ?? existing.coreVersion,
      uiVersion: req.uiVersion ?? existing.uiVersion,
      deviceFamily: req.deviceFamily ?? existing.deviceFamily,
      modelIdentifier: req.modelIdentifier ?? existing.modelIdentifier,
      caps: req.caps ?? existing.caps,
      commands: req.commands ?? existing.commands,
      permissions: req.permissions ?? existing.permissions,
      remoteIp: req.remoteIp ?? existing.remoteIp,
      silent: Boolean(existing.silent && req.silent),
      isRepair: existing.isRepair || isRepair,
      ts: Date.now(),
    };
    upsertPendingNodePairingInDb(merged);
    return { status: "pending" as const, request: merged, created: false };
  }

  const request: NodePairingPendingRequest = {
    requestId: randomUUID(),
    nodeId,
    displayName: req.displayName,
    platform: req.platform,
    version: req.version,
    coreVersion: req.coreVersion,
    uiVersion: req.uiVersion,
    deviceFamily: req.deviceFamily,
    modelIdentifier: req.modelIdentifier,
    caps: req.caps,
    commands: req.commands,
    permissions: req.permissions,
    remoteIp: req.remoteIp,
    silent: req.silent,
    isRepair,
    ts: Date.now(),
  };
  upsertPendingNodePairingInDb(request);
  return { status: "pending" as const, request, created: true };
}

export async function approveNodePairing(
  requestId: string,
): Promise<{ requestId: string; node: NodePairingPairedNode } | null> {
  const pending = getPendingNodePairingFromDb(requestId);
  if (!pending) {
    return null;
  }
  const now = Date.now();
  const existing = getPairedNodeFromDb(pending.nodeId);
  const node: NodePairingPairedNode = {
    nodeId: pending.nodeId,
    token: newToken(),
    displayName: pending.displayName,
    platform: pending.platform,
    version: pending.version,
    coreVersion: pending.coreVersion,
    uiVersion: pending.uiVersion,
    deviceFamily: pending.deviceFamily,
    modelIdentifier: pending.modelIdentifier,
    caps: pending.caps,
    commands: pending.commands,
    permissions: pending.permissions,
    remoteIp: pending.remoteIp,
    createdAtMs: existing?.createdAtMs ?? now,
    approvedAtMs: now,
  };
  deletePendingNodePairingFromDb(requestId);
  upsertPairedNodeInDb(node);
  return { requestId, node };
}

export async function rejectNodePairing(
  requestId: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  const pending = getPendingNodePairingFromDb(requestId);
  if (!pending) {
    return null;
  }
  deletePendingNodePairingFromDb(requestId);
  return { requestId, nodeId: pending.nodeId };
}

export async function verifyNodeToken(
  nodeId: string,
  token: string,
): Promise<{ ok: boolean; node?: NodePairingPairedNode }> {
  const normalized = normalizeNodeId(nodeId);
  const node = getPairedNodeFromDb(normalized);
  if (!node) {
    return { ok: false };
  }
  return verifyPairingToken(token, node.token) ? { ok: true, node } : { ok: false };
}

export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>,
) {
  const normalized = normalizeNodeId(nodeId);
  const existing = getPairedNodeFromDb(normalized);
  if (!existing) {
    return;
  }
  upsertPairedNodeInDb({
    ...existing,
    displayName: patch.displayName ?? existing.displayName,
    platform: patch.platform ?? existing.platform,
    version: patch.version ?? existing.version,
    coreVersion: patch.coreVersion ?? existing.coreVersion,
    uiVersion: patch.uiVersion ?? existing.uiVersion,
    deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
    modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
    remoteIp: patch.remoteIp ?? existing.remoteIp,
    caps: patch.caps ?? existing.caps,
    commands: patch.commands ?? existing.commands,
    bins: patch.bins ?? existing.bins,
    permissions: patch.permissions ?? existing.permissions,
    lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs,
  });
}

export async function renamePairedNode(
  nodeId: string,
  displayName: string,
): Promise<NodePairingPairedNode | null> {
  const normalized = normalizeNodeId(nodeId);
  const existing = getPairedNodeFromDb(normalized);
  if (!existing) {
    return null;
  }
  const trimmed = displayName.trim();
  if (!trimmed) {
    throw new Error("displayName required");
  }
  const next: NodePairingPairedNode = { ...existing, displayName: trimmed };
  upsertPairedNodeInDb(next);
  return next;
}
