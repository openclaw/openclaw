// Manages node pairing identities for gateway and remote device trust.
import { randomUUID } from "node:crypto";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import { type NodeApprovalScope, resolveNodePairApprovalScopes } from "./node-pairing-authz.js";
import { sameNodeApprovalSurfaceSet, sameNodePermissionSurface } from "./node-pairing-surface.js";
import {
  createAsyncLock,
  pruneExpiredPending,
  readJsonIfExists,
  reconcilePendingPairingRequests,
  coercePairingStateRecord,
  resolvePairingPaths,
  writeJson,
} from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

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

type NodeApprovedSurface = NodeDeclaredSurface;

/** Node-declared pairing surface before approval. */
export type NodePairingRequestInput = NodeDeclaredSurface & {
  silent?: boolean;
};

/** Pending node pairing request awaiting operator approval. */
export type NodePairingPendingRequest = NodePairingRequestInput & {
  requestId: string;
  silent?: boolean;
  ts: number;
};

type NodePairingPendingRecord = NodePairingPendingRequest & {
  revision?: string;
};

export type NodePairingPendingSnapshot = Pick<NodePairingPendingRequest, "requestId" | "nodeId"> & {
  revision?: string;
};

/** Opaque claim preventing approval while a reconnect resolves stale pending state. */
export type NodePairingCleanupClaim = {
  baseDir: string | undefined;
  generation: number;
  nodeId: string;
  pendingPath: string;
  observed: NodePairingPendingSnapshot[];
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

type NodePairingPendingEntry = NodePairingPendingRequest & {
  requiredApproveScopes: NodeApprovalScope[];
};

/** Approved node record with its pairing token and persisted capability surface. */
export type NodePairingPairedNode = NodeApprovedSurface & {
  token: string;
  bins?: string[];
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

type NodePairingList = {
  pending: NodePairingPendingEntry[];
  paired: NodePairingPairedNode[];
};

type NodePairingStateFile = {
  pendingById: Record<string, NodePairingPendingRecord>;
  pairedByNodeId: Record<string, NodePairingPairedNode>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const OPERATOR_ROLE = "operator";

const withLock = createAsyncLock();
const activeCleanupRevisionClaims = new Map<string, Set<number>>();
let nextCleanupClaimGeneration = 0;

function buildPendingNodePairingRequest(params: {
  requestId?: string;
  req: NodePairingRequestInput;
}): NodePairingPendingRecord {
  return {
    requestId: params.requestId ?? randomUUID(),
    revision: randomUUID(),
    nodeId: params.req.nodeId,
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
    ts: Date.now(),
  };
}

function refreshPendingNodePairingRequest(
  existing: NodePairingPendingRecord,
  incoming: NodePairingRequestInput,
): NodePairingPendingRecord {
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
    ts: Date.now(),
  };
}

function samePendingApprovalSurface(
  existing: NodePairingPendingRecord,
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

function samePendingReconnectMetadata(
  existing: NodePairingPendingRecord,
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

function mergeNodePairingReplacementInput(params: {
  existing: readonly NodePairingPendingRecord[];
  incoming: NodePairingRequestInput;
}): NodePairingRequestInput {
  const latest = params.existing[0];
  return {
    nodeId: params.incoming.nodeId,
    clientId: params.incoming.clientId ?? latest?.clientId,
    clientMode: params.incoming.clientMode ?? latest?.clientMode,
    displayName: params.incoming.displayName ?? latest?.displayName,
    platform: params.incoming.platform ?? latest?.platform,
    version: params.incoming.version ?? latest?.version,
    coreVersion: params.incoming.coreVersion ?? latest?.coreVersion,
    uiVersion: params.incoming.uiVersion ?? latest?.uiVersion,
    deviceFamily: params.incoming.deviceFamily ?? latest?.deviceFamily,
    modelIdentifier: params.incoming.modelIdentifier ?? latest?.modelIdentifier,
    caps: params.incoming.caps ?? latest?.caps,
    commands: params.incoming.commands ?? latest?.commands,
    permissions: params.incoming.permissions ?? latest?.permissions,
    remoteIp: params.incoming.remoteIp ?? latest?.remoteIp,
    silent: Boolean(
      params.incoming.silent && params.existing.every((pending) => pending.silent === true),
    ),
  };
}

function resolveNodeApprovalRequiredScopes(pending: NodePairingPendingRecord): NodeApprovalScope[] {
  const commands = Array.isArray(pending.commands) ? pending.commands : [];
  return resolveNodePairApprovalScopes(commands);
}

function toPublicPendingNodePairingRequest(
  pending: NodePairingPendingRecord,
): NodePairingPendingRequest {
  const { revision: _revision, ...request } = pending;
  return request;
}

function toPendingNodePairingSnapshot(
  pending: NodePairingPendingRecord,
): NodePairingPendingSnapshot {
  const snapshot: NodePairingPendingSnapshot = {
    requestId: pending.requestId,
    nodeId: pending.nodeId,
  };
  if (pending.revision) {
    snapshot.revision = pending.revision;
  }
  return snapshot;
}

function toPendingNodePairingEntry(pending: NodePairingPendingRecord): NodePairingPendingEntry {
  return {
    ...toPublicPendingNodePairingRequest(pending),
    requiredApproveScopes: resolveNodeApprovalRequiredScopes(pending),
  };
}

type ApprovedNodePairingResult = { requestId: string; node: NodePairingPairedNode };
type ForbiddenNodePairingResult = { status: "forbidden"; missingScope: string };
type ApproveNodePairingResult = ApprovedNodePairingResult | ForbiddenNodePairingResult | null;

async function loadState(baseDir?: string): Promise<NodePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  const [pending, paired] = await Promise.all([
    readJsonIfExists<unknown>(pendingPath),
    readJsonIfExists<unknown>(pairedPath),
  ]);
  const state: NodePairingStateFile = {
    pendingById: coercePairingStateRecord<NodePairingPendingRecord>(pending),
    pairedByNodeId: coercePairingStateRecord<NodePairingPairedNode>(paired),
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}

async function persistState(state: NodePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  await Promise.all([
    writeJson(pendingPath, state.pendingById),
    writeJson(pairedPath, state.pairedByNodeId),
  ]);
}

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function buildCleanupRevisionClaimKey(
  pendingPath: string,
  observed: NodePairingPendingSnapshot,
): string {
  return `${pendingPath}\0${observed.requestId}\0${observed.revision ?? ""}`;
}

function addCleanupClaim(claim: NodePairingCleanupClaim): void {
  for (const observed of claim.observed) {
    const key = buildCleanupRevisionClaimKey(claim.pendingPath, observed);
    const generations = activeCleanupRevisionClaims.get(key) ?? new Set<number>();
    generations.add(claim.generation);
    activeCleanupRevisionClaims.set(key, generations);
  }
}

function cleanupClaimIsActive(claim: NodePairingCleanupClaim): boolean {
  return claim.observed.some((observed) => {
    const key = buildCleanupRevisionClaimKey(claim.pendingPath, observed);
    return activeCleanupRevisionClaims.get(key)?.has(claim.generation) === true;
  });
}

function removeCleanupClaim(claim: NodePairingCleanupClaim): void {
  for (const observed of claim.observed) {
    const key = buildCleanupRevisionClaimKey(claim.pendingPath, observed);
    const generations = activeCleanupRevisionClaims.get(key);
    generations?.delete(claim.generation);
    if (!generations || generations.size === 0) {
      activeCleanupRevisionClaims.delete(key);
    }
  }
}

function invalidateCleanupClaimsThrough(
  claim: NodePairingCleanupClaim,
  pending: NodePairingPendingRecord,
  baseDir: string | undefined,
): void {
  const pendingPath = resolvePairingPaths(baseDir, "nodes").pendingPath;
  const key = buildCleanupRevisionClaimKey(pendingPath, toPendingNodePairingSnapshot(pending));
  const generations = activeCleanupRevisionClaims.get(key);
  if (!generations) {
    return;
  }
  for (const generation of generations) {
    if (generation <= claim.generation) {
      generations.delete(generation);
    }
  }
  if (generations.size === 0) {
    activeCleanupRevisionClaims.delete(key);
  }
}

function newToken() {
  return generatePairingToken();
}

export async function listNodePairing(baseDir?: string): Promise<NodePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById)
    .toSorted((a, b) => b.ts - a.ts)
    .map(toPendingNodePairingEntry);
  const paired = Object.values(state.pairedByNodeId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

/** Snapshot pairing state and claim current pending revisions for one paired reconnect. */
export async function beginNodePairingConnect(
  nodeId: string,
  baseDir?: string,
): Promise<{
  pairedNode: NodePairingPairedNode | null;
  cleanupClaim?: NodePairingCleanupClaim;
}> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const pairedNode = state.pairedByNodeId[normalized] ?? null;
    const observed = Object.values(state.pendingById)
      .filter((entry) => entry.nodeId === normalized)
      .map(toPendingNodePairingSnapshot);
    if (!pairedNode || observed.length === 0) {
      return { pairedNode };
    }
    const pendingPath = resolvePairingPaths(baseDir, "nodes").pendingPath;
    const claim: NodePairingCleanupClaim = {
      baseDir,
      generation: ++nextCleanupClaimGeneration,
      nodeId: normalized,
      pendingPath,
      observed,
    };
    addCleanupClaim(claim);
    return { pairedNode, cleanupClaim: claim };
  });
}

function pendingHasActiveCleanupClaim(
  pending: NodePairingPendingRecord,
  baseDir: string | undefined,
): boolean {
  const pendingPath = resolvePairingPaths(baseDir, "nodes").pendingPath;
  const key = buildCleanupRevisionClaimKey(pendingPath, toPendingNodePairingSnapshot(pending));
  return (activeCleanupRevisionClaims.get(key)?.size ?? 0) > 0;
}

/** Release a reconnect cleanup claim without changing pending pairing state. */
export async function releaseNodePairingCleanupClaim(
  claim: NodePairingCleanupClaim,
): Promise<void> {
  await withLock(async () => {
    removeCleanupClaim(claim);
  });
}

/** Delete pending revisions claimed by a reconnect after hello succeeds. */
export async function finalizeNodePairingCleanupClaim(
  claim: NodePairingCleanupClaim,
): Promise<NodePairingSupersededRequest[]> {
  return await withLock(async () => {
    if (!cleanupClaimIsActive(claim)) {
      return [];
    }
    try {
      const state = await loadState(claim.baseDir);
      const observedById = new Map(
        claim.observed
          .filter((entry) => entry.nodeId === claim.nodeId)
          .map((entry) => [entry.requestId, entry] as const),
      );
      const rejected = Object.values(state.pendingById)
        .filter((pending) => {
          const observed = observedById.get(pending.requestId);
          return observed !== undefined && observed.revision === pending.revision;
        })
        .toSorted((left, right) => right.ts - left.ts);
      if (rejected.length === 0) {
        return [];
      }
      for (const pending of rejected) {
        delete state.pendingById[pending.requestId];
      }
      await persistState(state, claim.baseDir);
      return rejected.map((pending) => ({
        requestId: pending.requestId,
        nodeId: pending.nodeId,
      }));
    } finally {
      removeCleanupClaim(claim);
    }
  });
}

/** Create or refresh a pending node pairing request for operator approval. */
export async function requestNodePairing(
  req: NodePairingRequestInput,
  baseDir?: string,
): Promise<RequestNodePairingResult> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const nodeId = normalizeNodeId(req.nodeId);
    if (!nodeId) {
      throw new Error("nodeId required");
    }
    const pendingForNode = Object.values(state.pendingById)
      .filter((pending) => pending.nodeId === nodeId)
      .toSorted((left, right) => right.ts - left.ts);
    const result = await reconcilePendingPairingRequests({
      pendingById: state.pendingById,
      existing: pendingForNode,
      incoming: {
        ...req,
        nodeId,
      },
      canRefreshSingle: (existing, incoming) => samePendingApprovalSurface(existing, incoming),
      refreshSingle: (existing, incoming) => refreshPendingNodePairingRequest(existing, incoming),
      buildReplacement: ({ existing, incoming }) =>
        buildPendingNodePairingRequest({
          req: mergeNodePairingReplacementInput({ existing, incoming }),
        }),
      persist: async () => await persistState(state, baseDir),
    });
    const superseded = result.created
      ? pendingForNode
          .filter((pending) => pending.requestId !== result.request.requestId)
          .map((pending) => ({ requestId: pending.requestId, nodeId: pending.nodeId }))
      : [];
    const publicResult = {
      ...result,
      request: toPublicPendingNodePairingRequest(result.request),
    };
    return superseded.length > 0 ? { ...publicResult, superseded } : publicResult;
  });
}

/** Reuse an unchanged reconnect request without refreshing or writing pairing state. */
export async function reusePendingNodePairingForReconnect(
  req: NodePairingRequestInput,
  cleanupClaim: NodePairingCleanupClaim | undefined,
  baseDir?: string,
): Promise<RequestNodePairingResult | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const nodeId = normalizeNodeId(req.nodeId);
    const pendingForNode = Object.values(state.pendingById)
      .filter((pending) => pending.nodeId === nodeId)
      .toSorted((left, right) => right.ts - left.ts);
    if (
      pendingForNode.length === 1 &&
      samePendingApprovalSurface(pendingForNode[0], { ...req, nodeId }) &&
      samePendingReconnectMetadata(pendingForNode[0], req)
    ) {
      const pending = pendingForNode[0];
      // The unchanged reconnect supersedes older cleanup ownership without
      // refreshing the request or writing pairing state.
      if (cleanupClaim) {
        invalidateCleanupClaimsThrough(cleanupClaim, pending, baseDir);
      }
      return {
        status: "pending",
        request: toPublicPendingNodePairingRequest(pending),
        created: false,
      };
    }
    return null;
  });
}

/** Approve a pending node request when caller scopes cover the requested command surface. */
export async function approveNodePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveNodePairingResult> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    // A paired reconnect has atomically observed this revision as stale.
    // Approval can resume if the handshake fails and releases its claim.
    if (pendingHasActiveCleanupClaim(pending, baseDir)) {
      return null;
    }
    const requiredScopes = resolveNodeApprovalRequiredScopes(pending);
    const missingScope = resolveMissingRequestedScope({
      role: OPERATOR_ROLE,
      requestedScopes: requiredScopes,
      allowedScopes: options.callerScopes ?? [],
    });
    if (missingScope) {
      return { status: "forbidden", missingScope };
    }

    const now = Date.now();
    const existing = state.pairedByNodeId[pending.nodeId];
    const node: NodePairingPairedNode = {
      nodeId: pending.nodeId,
      token: newToken(),
      clientId: pending.clientId,
      clientMode: pending.clientMode,
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

    delete state.pendingById[requestId];
    state.pairedByNodeId[pending.nodeId] = node;
    await persistState(state, baseDir);
    return { requestId, node };
  });
}

/** Reject a pending node pairing request. */
export async function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  return await withLock(async () => {
    return await rejectPendingPairingRequest<
      NodePairingPendingRequest,
      NodePairingStateFile,
      "nodeId"
    >({
      requestId,
      idKey: "nodeId",
      loadState: () => loadState(baseDir),
      persistState: (state) => persistState(state, baseDir),
      getId: (pending: NodePairingPendingRequest) => pending.nodeId,
    });
  });
}

/** Remove a paired node without disturbing unrelated pending requests. */
export async function removePairedNode(
  nodeId: string,
  baseDir?: string,
): Promise<{ nodeId: string } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    if (!normalized || !state.pairedByNodeId[normalized]) {
      return null;
    }
    delete state.pairedByNodeId[normalized];
    await persistState(state, baseDir);
    return { nodeId: normalized };
  });
}

/** Verify a paired node token and return the approved node record on success. */
export async function verifyNodeToken(
  nodeId: string,
  token: string,
  baseDir?: string,
): Promise<{ ok: boolean; node?: NodePairingPairedNode }> {
  const state = await loadState(baseDir);
  const normalized = normalizeNodeId(nodeId);
  const node = state.pairedByNodeId[normalized];
  if (!node) {
    return { ok: false };
  }
  return verifyPairingToken(token, node.token) ? { ok: true, node } : { ok: false };
}

/** Update non-auth metadata for a paired node heartbeat/status refresh. */
export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return false;
    }

    const next: NodePairingPairedNode = {
      ...existing,
      clientId: patch.clientId ?? existing.clientId,
      clientMode: patch.clientMode ?? existing.clientMode,
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
      lastSeenAtMs: patch.lastSeenAtMs ?? existing.lastSeenAtMs,
      lastSeenReason: patch.lastSeenReason ?? existing.lastSeenReason,
    };

    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
    return true;
  });
}

/** Rename a paired node display name while preserving token and approval metadata. */
export async function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return null;
    }
    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("displayName required");
    }
    const next: NodePairingPairedNode = { ...existing, displayName: trimmed };
    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
    return next;
  });
}
