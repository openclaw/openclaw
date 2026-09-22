import { randomUUID } from "node:crypto";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { revokeDeviceBootstrapTokensForDeviceInDatabase } from "./device-bootstrap.worker-kernel.js";
import type {
  RequestDevicePairingResult,
  PairedDeviceMetadataPatch,
  PrunedSupersededPairedDevice,
} from "./device-pairing-core.types.js";
// Manages device pairing requests, records, metadata, and node pairing state.
import {
  listApprovedPairedDeviceRoles,
  resolveNodePairingGeneration,
  type NodePairingGeneration,
} from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import {
  cloneDevicePairingTokens,
  loadDevicePairingStateForMutation,
  mergeDevicePairingRoles,
  mergeDevicePairingScopes,
  normalizeDevicePairingId,
  normalizeDevicePairingRole,
  preserveDeviceRoleScopes,
  reconcilePendingPairingRequests,
  resolvePairingRequestExpiry,
  resolveRequestedDeviceRoles,
  sameDevicePairingStringSet,
} from "./device-pairing-state.kernel.js";
import {
  persistDevicePairingStoreState as persistState,
  updatePairedDevicePresenceInTransaction,
} from "./device-pairing-store.js";
import type {
  DevicePairingPendingRecord,
  DevicePairingPendingRequest,
  PairedDevice,
} from "./device-pairing.types.js";

function resolveRequestedScopes(input: { scopes?: string[] }): string[] {
  return normalizeDeviceAuthScopes(input.scopes);
}

function samePendingApprovalSnapshot(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (existing.browserOrigin !== incoming.browserOrigin) {
    return false;
  }
  if (normalizeDevicePairingRole(existing.role) !== normalizeDevicePairingRole(incoming.role)) {
    return false;
  }
  if (
    !sameDevicePairingStringSet(
      resolveRequestedDeviceRoles(existing),
      resolveRequestedDeviceRoles(incoming),
    ) ||
    !sameDevicePairingStringSet(resolveRequestedScopes(existing), resolveRequestedScopes(incoming))
  ) {
    return false;
  }
  return true;
}

function isStringSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const supersetSet = new Set(superset);
  for (const value of subset) {
    if (!supersetSet.has(value)) {
      return false;
    }
  }
  return true;
}

// True when the incoming request only asks for roles/scopes a single existing pending
// request (same key + role) already covers. Such subset re-requests refresh in place so
// the owner's listed requestId stays valid; escalations still supersede with a fresh id.
function incomingApprovalCoveredByExisting(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (existing.browserOrigin !== incoming.browserOrigin) {
    return false;
  }
  if (normalizeDevicePairingRole(existing.role) !== normalizeDevicePairingRole(incoming.role)) {
    return false;
  }
  const incomingRoles = resolveRequestedDeviceRoles(incoming);
  if (!isStringSubset(incomingRoles, resolveRequestedDeviceRoles(existing))) {
    return false;
  }
  const existingScopes = resolveRequestedScopes(existing);
  for (const scope of resolveRequestedScopes(incoming)) {
    const covered = incomingRoles.some((role) =>
      roleScopesAllow({
        role,
        requestedScopes: [scope],
        allowedScopes: existingScopes,
      }),
    );
    if (!covered) {
      return false;
    }
  }
  return true;
}

function refreshPendingDevicePairingRequest(
  existing: DevicePairingPendingRecord,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  isRepair: boolean,
  nowMs: number,
): DevicePairingPendingRecord {
  return {
    ...existing,
    publicKey: incoming.publicKey,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    browserOrigin: existing.browserOrigin,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // If either request is interactive, keep the pending request visible for approval.
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    // Preserve the original creation timestamp so that reconnects cannot bump this
    // request's queue position. Using Date.now() here would let an attacker silently
    // refresh recency and win the implicit --latest approval race.
    ts: existing.ts,
    // Keepalive for the pending TTL only (see pruneExpiredPending); never affects ordering.
    refreshedAtMs: nowMs,
  };
}

function resolveSupersededPendingSilent(params: {
  existing: readonly DevicePairingPendingRequest[];
  incomingSilent: boolean | undefined;
}): boolean {
  return Boolean(
    params.incomingSilent && params.existing.every((pending) => pending.silent === true),
  );
}

function toPublicPendingDevicePairingRequest(
  pending: DevicePairingPendingRecord,
): DevicePairingPendingRequest {
  const { refreshedAtMs: _refreshedAtMs, ...request } = pending;
  return request;
}

function buildPendingDevicePairingRequest(params: {
  requestId?: string;
  nowMs: number;
  deviceId: string;
  isRepair: boolean;
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">;
}): DevicePairingPendingRequest {
  const role = normalizeDevicePairingRole(params.req.role) ?? undefined;
  return {
    requestId: params.requestId ?? randomUUID(),
    deviceId: params.deviceId,
    publicKey: params.req.publicKey,
    displayName: params.req.displayName,
    platform: params.req.platform,
    deviceFamily: params.req.deviceFamily,
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    browserOrigin: params.req.browserOrigin,
    role,
    roles: mergeDevicePairingRoles(params.req.roles, role),
    scopes: mergeDevicePairingScopes(params.req.scopes),
    remoteIp: params.req.remoteIp,
    silent: params.req.silent,
    isRepair: params.isRepair,
    ts: params.nowMs,
  };
}

/** Create or refresh a pending device pairing request for owner approval. */
export function requestDevicePairingInWorker(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  nowMs: number,
  baseDir?: string,
): RequestDevicePairingResult {
  const state = loadDevicePairingStateForMutation(nowMs, baseDir);
  const deviceId = normalizeDevicePairingId(req.deviceId);
  if (!deviceId) {
    throw new Error("deviceId required");
  }
  const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
  const pendingForDevice = Object.values(state.pendingById)
    .filter((pending) => pending.deviceId === deviceId)
    .toSorted((left, right) => right.ts - left.ts);
  const result = reconcilePendingPairingRequests({
    pendingById: state.pendingById,
    existing: pendingForDevice,
    incoming: req,
    canRefreshSingle: (existing, incoming) =>
      samePendingApprovalSnapshot(existing, incoming) ||
      incomingApprovalCoveredByExisting(existing, incoming),
    refreshSingle: (existing, incoming) =>
      refreshPendingDevicePairingRequest(existing, incoming, isRepair, nowMs),
    buildReplacement: ({ existing, incoming }) => {
      const latestPending = existing[0];
      const mergedRoles = mergeDevicePairingRoles(
        ...existing.flatMap((pending) => [pending.roles, pending.role]),
        incoming.roles,
        incoming.role,
      );
      const mergedScopes = mergeDevicePairingScopes(
        ...existing.map((pending) => pending.scopes),
        incoming.scopes,
      );
      return buildPendingDevicePairingRequest({
        nowMs,
        deviceId,
        isRepair,
        req: {
          ...incoming,
          role: normalizeDevicePairingRole(incoming.role) ?? latestPending?.role,
          roles: mergedRoles,
          scopes: mergedScopes,
          // Preserve interactive visibility when superseding pending requests:
          // if any previous pending request was interactive, keep this one interactive.
          silent: resolveSupersededPendingSilent({
            existing,
            incomingSilent: incoming.silent,
          }),
        },
      });
    },
    persist: () => persistState(state, baseDir, "pending"),
  });
  // Surface superseded requestIds so callers can broadcast their resolution;
  // clients otherwise keep prompting for requests that can no longer be approved.
  const superseded = result.created
    ? pendingForDevice
        .filter((pending) => pending.requestId !== result.request.requestId)
        .map((pending) => ({ requestId: pending.requestId, deviceId: pending.deviceId }))
    : [];
  const publicResult = {
    ...result,
    request: toPublicPendingDevicePairingRequest(result.request),
    expiresAtMs: resolvePairingRequestExpiry(result.request.refreshedAtMs ?? result.request.ts),
  };
  return superseded.length > 0 ? { ...publicResult, superseded } : publicResult;
}

/** Reject a pending request and revoke matching bootstrap tokens for that device. */
export function rejectDevicePairingInWorker(
  database: OpenClawStateDatabase,
  requestId: string,
  nowMs: number,
  baseDir?: string,
): { requestId: string; deviceId: string } | null {
  const state = loadDevicePairingStateForMutation(nowMs, baseDir);
  const pending = state.pendingById[requestId];
  if (!pending) {
    return null;
  }
  delete state.pendingById[requestId];
  persistState(state, baseDir, "pending");
  revokeDeviceBootstrapTokensForDeviceInDatabase(database, {
    deviceId: pending.deviceId,
    publicKey: pending.publicKey,
    nowMs,
  });
  return { requestId, deviceId: pending.deviceId };
}

/** Remove a paired device and any pending repair requests for the same device id. */
export function removePairedDeviceInWorker(
  deviceId: string,
  nowMs: number,
  baseDir?: string,
): { deviceId: string } | null {
  const state = loadDevicePairingStateForMutation(nowMs, baseDir);
  const normalized = normalizeDevicePairingId(deviceId);
  if (!normalized || !state.pairedByDeviceId[normalized]) {
    return null;
  }
  delete state.pairedByDeviceId[normalized];
  for (const [requestId, pending] of Object.entries(state.pendingById)) {
    if (pending.deviceId === normalized) {
      delete state.pendingById[requestId];
    }
  }
  persistState(state, baseDir, "both", { clearApnsNodeIds: [normalized] });
  return { deviceId: normalized };
}

// Silent pairings from the same client software on the same host mint a fresh
// deviceId whenever their state dir (and thus keypair) is ephemeral. The cluster
// key groups those records so a replacement pairing can retire its predecessors.
function silentPairingClusterKey(
  device: Pick<PairedDevice, "clientId" | "clientMode" | "displayName">,
): string | null {
  const clientId = device.clientId?.trim().toLowerCase() ?? "";
  const clientMode = device.clientMode?.trim().toLowerCase() ?? "";
  const displayName = device.displayName?.trim().toLowerCase() ?? "";
  if (!clientId && !clientMode && !displayName) {
    return null;
  }
  return `${clientId}\0${clientMode}\0${displayName}`;
}

// A concurrently approved sibling may still be mid-handshake and not yet visible
// to the connected-clients check; freshly approved records are never prune
// candidates so parallel silent pairings cannot delete each other's rows.
const PRUNE_RECENT_APPROVAL_GRACE_MS = 60_000;

/**
 * Remove silent-approved sibling records superseded by a newly approved silent
 * pairing of the same client cluster. Only records whose latest approval was
 * same-host local ("silent") are eligible, as anchor and as victim: local
 * clients re-pair silently by construction and share the gateway host, so the
 * metadata cluster key cannot match a different machine. Currently connected
 * devices are skipped so concurrent sessions with distinct state dirs keep
 * their tokens while live.
 */
export function pruneSupersededSilentPairedDevicesInWorker(params: {
  deviceId: string;
  baseDir?: string;
  protectedDeviceIds: readonly string[];
  nowMs: number;
}): PrunedSupersededPairedDevice[] {
  const state = loadDevicePairingStateForMutation(params.nowMs, params.baseDir);
  const anchor = state.pairedByDeviceId[normalizeDevicePairingId(params.deviceId)];
  if (!anchor || anchor.approvedVia !== "silent") {
    return [];
  }
  const anchorKey = silentPairingClusterKey(anchor);
  if (!anchorKey) {
    return [];
  }
  const nowMs = params.nowMs;
  const protectedDeviceIds = new Set(params.protectedDeviceIds);
  const removed: PrunedSupersededPairedDevice[] = [];
  for (const device of Object.values(state.pairedByDeviceId)) {
    if (device.deviceId === anchor.deviceId) {
      continue;
    }
    // Legacy records without approvedVia stay untouched (fail-safe).
    if (device.approvedVia !== "silent") {
      continue;
    }
    if (silentPairingClusterKey(device) !== anchorKey) {
      continue;
    }
    if (nowMs - device.approvedAtMs < PRUNE_RECENT_APPROVAL_GRACE_MS) {
      continue;
    }
    if (protectedDeviceIds.has(device.deviceId)) {
      continue;
    }
    delete state.pairedByDeviceId[device.deviceId];
    for (const [requestId, pending] of Object.entries(state.pendingById)) {
      if (pending.deviceId === device.deviceId) {
        delete state.pendingById[requestId];
      }
    }
    removed.push({
      deviceId: device.deviceId,
      roles: listApprovedPairedDeviceRoles(device),
    });
  }
  if (removed.length === 0) {
    return [];
  }
  requestDevicePairingMutationAdmission({
    kind: "pairing-prune",
    deviceIds: removed.map((entry) => entry.deviceId),
  });
  persistState(state, params.baseDir, "both", {
    clearApnsNodeIds: removed.map((entry) => entry.deviceId),
  });
  return removed;
}

/** Remove one approved paired-device role while preserving unrelated role tokens. */
export function removePairedDeviceRoleInWorker(params: {
  deviceId: string;
  role: string;
  nowMs: number;
  baseDir?: string;
}): { deviceId: string; role: string; removedDevice: boolean } | null {
  const state = loadDevicePairingStateForMutation(params.nowMs, params.baseDir);
  const normalizedDeviceId = normalizeDevicePairingId(params.deviceId);
  const role = normalizeDevicePairingRole(params.role);
  const device = state.pairedByDeviceId[normalizedDeviceId];
  if (!device || !role || !listApprovedPairedDeviceRoles(device).includes(role)) {
    return null;
  }

  const tokens = cloneDevicePairingTokens(device);
  delete tokens[role];
  const remainingRoles = listApprovedPairedDeviceRoles(device).filter((entry) => entry !== role);
  if (remainingRoles.length === 0) {
    for (const [requestId, pending] of Object.entries(state.pendingById)) {
      if (pending.deviceId === normalizedDeviceId) {
        delete state.pendingById[requestId];
      }
    }
    delete state.pairedByDeviceId[normalizedDeviceId];
    persistState(state, params.baseDir, "both", {
      clearApnsNodeIds: [normalizedDeviceId],
    });
    return { deviceId: normalizedDeviceId, role, removedDevice: true };
  }

  for (const [requestId, pending] of Object.entries(state.pendingById)) {
    if (pending.deviceId !== normalizedDeviceId) {
      continue;
    }
    const pendingRoles = resolveRequestedDeviceRoles(pending);
    if (!pendingRoles.includes(role)) {
      continue;
    }
    const nextPendingRoles = pendingRoles.filter((entry) => entry !== role);
    if (nextPendingRoles.length === 0) {
      delete state.pendingById[requestId];
      continue;
    }
    const pendingScopes = Array.isArray(pending.scopes)
      ? mergeDevicePairingScopes(
          ...nextPendingRoles.map((entry) => preserveDeviceRoleScopes(entry, pending.scopes)),
        )
      : undefined;
    state.pendingById[requestId] = {
      ...pending,
      role: nextPendingRoles[0],
      roles: nextPendingRoles,
      scopes: pendingScopes,
    };
  }

  const scopeBaseline = device.approvedScopes ?? device.scopes;
  const preservedScopes = Array.isArray(scopeBaseline)
    ? mergeDevicePairingScopes(
        ...remainingRoles.map((entry) => preserveDeviceRoleScopes(entry, scopeBaseline)),
      )
    : undefined;
  const next: PairedDevice = {
    ...device,
    role: remainingRoles[0],
    roles: remainingRoles,
    ...(preservedScopes !== undefined
      ? { scopes: preservedScopes, approvedScopes: preservedScopes }
      : {}),
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
  };
  if (role === "node") {
    // The node capability surface is bound to the node role; revoking the
    // role must revoke approved command exposure with it.
    delete next.nodeSurface;
    delete next.pendingNodeSurface;
  }
  state.pairedByDeviceId[normalizedDeviceId] = next;
  persistState(state, params.baseDir, "both");
  return { deviceId: normalizedDeviceId, role, removedDevice: false };
}

/** Update non-auth metadata for a paired device presence/status refresh. */
export function updatePairedDeviceMetadataInWorker(
  deviceId: string,
  patch: Partial<PairedDeviceMetadataPatch>,
  nowMs: number,
  baseDir?: string,
): boolean {
  const state = loadDevicePairingStateForMutation(nowMs, baseDir);
  const normalizedDeviceId = normalizeDevicePairingId(deviceId);
  const existing = state.pairedByDeviceId[normalizedDeviceId];
  if (!existing) {
    return false;
  }
  const next = { ...existing };
  if ("displayName" in patch) {
    next.displayName = patch.displayName;
  }
  if ("operatorLabel" in patch) {
    next.operatorLabel = patch.operatorLabel;
  }
  if ("platform" in patch) {
    next.platform = patch.platform;
  }
  if ("clientId" in patch) {
    next.clientId = patch.clientId;
  }
  if ("clientMode" in patch) {
    next.clientMode = patch.clientMode;
  }
  if ("remoteIp" in patch) {
    next.remoteIp = patch.remoteIp;
  }
  if ("lastSeenAtMs" in patch) {
    next.lastSeenAtMs = patch.lastSeenAtMs;
  }
  if ("lastSeenReason" in patch) {
    next.lastSeenReason = patch.lastSeenReason;
  }
  state.pairedByDeviceId[normalizedDeviceId] = next;
  persistState(state, baseDir, "paired");
  return true;
}

/** Update paired-device presence only while the authenticated node generation still owns it. */
export function updatePairedDevicePresenceInWorker(
  deviceId: string,
  patch: { lastSeenAtMs: number; lastSeenReason: string },
  expectedPairingGeneration: NodePairingGeneration,
  baseDir?: string,
): boolean {
  const updated = updatePairedDevicePresenceInTransaction<boolean>(deviceId, baseDir, (device) => {
    const currentPairingGeneration = resolveNodePairingGeneration(device);
    if (
      !device ||
      expectedPairingGeneration.nodeId !== device.deviceId ||
      currentPairingGeneration?.key !== expectedPairingGeneration.key
    ) {
      return { value: false, persist: false };
    }
    return {
      value: true,
      persist: true,
      lastSeenAtMs: patch.lastSeenAtMs,
      lastSeenReason: patch.lastSeenReason,
    };
  });
  return updated;
}
