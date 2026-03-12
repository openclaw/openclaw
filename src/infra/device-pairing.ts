import { randomUUID } from "node:crypto";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";
import {
  deletePairedDeviceFromDb,
  deletePendingDevicePairingFromDb,
  getPairedDeviceFromDb,
  getPairedDevicesFromDb,
  getPendingDevicePairingByDeviceIdFromDb,
  getPendingDevicePairingFromDb,
  getPendingDevicePairingsFromDb,
  upsertPairedDeviceInDb,
  upsertPendingDevicePairingInDb,
} from "./state-db/device-pairing-sqlite.js";

export type DevicePairingPendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type DeviceAuthToken = {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type DeviceAuthTokenSummary = {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  approvedScopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  createdAtMs: number;
  approvedAtMs: number;
};

export type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};

const PENDING_TTL_MS = 5 * 60 * 1000;

function normalizeDeviceId(deviceId: string) {
  return deviceId.trim();
}

function normalizeRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

function mergeRoles(...items: Array<string | string[] | undefined>): string[] | undefined {
  const roles = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const role of item) {
        const trimmed = role.trim();
        if (trimmed) {
          roles.add(trimmed);
        }
      }
    } else {
      const trimmed = item.trim();
      if (trimmed) {
        roles.add(trimmed);
      }
    }
  }
  if (roles.size === 0) {
    return undefined;
  }
  return [...roles];
}

function mergeScopes(...items: Array<string[] | undefined>): string[] | undefined {
  const scopes = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    for (const scope of item) {
      const trimmed = scope.trim();
      if (trimmed) {
        scopes.add(trimmed);
      }
    }
  }
  if (scopes.size === 0) {
    return undefined;
  }
  return [...scopes];
}

function mergePendingDevicePairingRequest(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  isRepair: boolean,
): DevicePairingPendingRequest {
  const existingRole = normalizeRole(existing.role);
  const incomingRole = normalizeRole(incoming.role);
  return {
    ...existing,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    role: existingRole ?? incomingRole ?? undefined,
    roles: mergeRoles(existing.roles, existing.role, incoming.role),
    scopes: mergeScopes(existing.scopes, incoming.scopes),
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // If either request is interactive, keep the pending request visible for approval.
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    ts: Date.now(),
  };
}

function scopesAllow(requested: string[], allowed: string[]): boolean {
  if (requested.length === 0) {
    return true;
  }
  if (allowed.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowed);
  return requested.every((scope) => allowedSet.has(scope));
}

const DEVICE_SCOPE_IMPLICATIONS: Readonly<Record<string, readonly string[]>> = {
  "operator.admin": ["operator.read", "operator.write", "operator.approvals", "operator.pairing"],
  "operator.write": ["operator.read"],
};

function expandScopeImplications(scopes: string[]): string[] {
  const expanded = new Set(scopes);
  const queue = [...scopes];
  while (queue.length > 0) {
    const scope = queue.pop();
    if (!scope) {
      continue;
    }
    for (const impliedScope of DEVICE_SCOPE_IMPLICATIONS[scope] ?? []) {
      if (!expanded.has(impliedScope)) {
        expanded.add(impliedScope);
        queue.push(impliedScope);
      }
    }
  }
  return [...expanded];
}

function scopesAllowWithImplications(requested: string[], allowed: string[]): boolean {
  return scopesAllow(expandScopeImplications(requested), expandScopeImplications(allowed));
}

function newToken() {
  return generatePairingToken();
}

function cloneDeviceTokens(device: PairedDevice): Record<string, DeviceAuthToken> {
  return device.tokens ? { ...device.tokens } : {};
}

function buildDeviceAuthToken(params: {
  role: string;
  scopes: string[];
  existing?: DeviceAuthToken;
  now: number;
  rotatedAtMs?: number;
}): DeviceAuthToken {
  return {
    token: newToken(),
    role: params.role,
    scopes: params.scopes,
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    rotatedAtMs: params.rotatedAtMs,
    revokedAtMs: undefined,
    lastUsedAtMs: params.existing?.lastUsedAtMs,
  };
}

function pruneExpiredPending(): void {
  const now = Date.now();
  for (const req of getPendingDevicePairingsFromDb()) {
    if (now - req.ts > PENDING_TTL_MS) {
      deletePendingDevicePairingFromDb(req.requestId);
    }
  }
}

export async function listDevicePairing(): Promise<DevicePairingList> {
  pruneExpiredPending();
  const pending = getPendingDevicePairingsFromDb().toSorted((a, b) => b.ts - a.ts);
  const paired = getPairedDevicesFromDb().toSorted((a, b) => b.approvedAtMs - a.approvedAtMs);
  return { pending, paired };
}

export async function getPairedDevice(deviceId: string): Promise<PairedDevice | null> {
  return getPairedDeviceFromDb(normalizeDeviceId(deviceId));
}

export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): Promise<{
  status: "pending";
  request: DevicePairingPendingRequest;
  created: boolean;
}> {
  pruneExpiredPending();
  const deviceId = normalizeDeviceId(req.deviceId);
  if (!deviceId) {
    throw new Error("deviceId required");
  }
  const isRepair = getPairedDeviceFromDb(deviceId) != null;
  const existingPending = getPendingDevicePairingByDeviceIdFromDb(deviceId);
  if (existingPending) {
    const merged = mergePendingDevicePairingRequest(existingPending, req, isRepair);
    upsertPendingDevicePairingInDb(merged);
    return { status: "pending" as const, request: merged, created: false };
  }

  const request: DevicePairingPendingRequest = {
    requestId: randomUUID(),
    deviceId,
    publicKey: req.publicKey,
    displayName: req.displayName,
    platform: req.platform,
    deviceFamily: req.deviceFamily,
    clientId: req.clientId,
    clientMode: req.clientMode,
    role: req.role,
    roles: req.role ? [req.role] : undefined,
    scopes: req.scopes,
    remoteIp: req.remoteIp,
    silent: req.silent,
    isRepair,
    ts: Date.now(),
  };
  upsertPendingDevicePairingInDb(request);
  return { status: "pending" as const, request, created: true };
}

export async function approveDevicePairing(
  requestId: string,
): Promise<{ requestId: string; device: PairedDevice } | null> {
  const pending = getPendingDevicePairingFromDb(requestId);
  if (!pending) {
    return null;
  }
  const now = Date.now();
  const existing = getPairedDeviceFromDb(pending.deviceId);
  const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
  const approvedScopes = mergeScopes(existing?.approvedScopes ?? existing?.scopes, pending.scopes);
  const tokens = existing?.tokens ? { ...existing.tokens } : {};
  const roleForToken = normalizeRole(pending.role);
  if (roleForToken) {
    const existingToken = tokens[roleForToken];
    const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
    const nextScopes =
      requestedScopes.length > 0
        ? requestedScopes
        : normalizeDeviceAuthScopes(
            existingToken?.scopes ?? approvedScopes ?? existing?.approvedScopes ?? existing?.scopes,
          );
    tokens[roleForToken] = {
      token: newToken(),
      role: roleForToken,
      scopes: nextScopes,
      createdAtMs: existingToken?.createdAtMs ?? now,
      rotatedAtMs: existingToken ? now : undefined,
      revokedAtMs: undefined,
      lastUsedAtMs: existingToken?.lastUsedAtMs,
    };
  }
  const device: PairedDevice = {
    deviceId: pending.deviceId,
    publicKey: pending.publicKey,
    displayName: pending.displayName,
    platform: pending.platform,
    deviceFamily: pending.deviceFamily,
    clientId: pending.clientId,
    clientMode: pending.clientMode,
    role: pending.role,
    roles,
    scopes: approvedScopes,
    approvedScopes,
    remoteIp: pending.remoteIp,
    tokens,
    createdAtMs: existing?.createdAtMs ?? now,
    approvedAtMs: now,
  };
  deletePendingDevicePairingFromDb(requestId);
  upsertPairedDeviceInDb(device);
  return { requestId, device };
}

export async function rejectDevicePairing(
  requestId: string,
): Promise<{ requestId: string; deviceId: string } | null> {
  const pending = getPendingDevicePairingFromDb(requestId);
  if (!pending) {
    return null;
  }
  deletePendingDevicePairingFromDb(requestId);
  return { requestId, deviceId: pending.deviceId };
}

export async function removePairedDevice(deviceId: string): Promise<{ deviceId: string } | null> {
  const normalized = normalizeDeviceId(deviceId);
  const deleted = deletePairedDeviceFromDb(normalized);
  return deleted ? { deviceId: normalized } : null;
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<
    Omit<PairedDevice, "deviceId" | "createdAtMs" | "approvedAtMs" | "approvedScopes">
  >,
): Promise<void> {
  const existing = getPairedDeviceFromDb(normalizeDeviceId(deviceId));
  if (!existing) {
    return;
  }
  const roles = mergeRoles(existing.roles, existing.role, patch.role);
  const scopes = mergeScopes(existing.scopes, patch.scopes);
  upsertPairedDeviceInDb({
    ...existing,
    ...patch,
    deviceId: existing.deviceId,
    createdAtMs: existing.createdAtMs,
    approvedAtMs: existing.approvedAtMs,
    approvedScopes: existing.approvedScopes,
    role: patch.role ?? existing.role,
    roles,
    scopes,
  });
}

export function summarizeDeviceTokens(
  tokens: Record<string, DeviceAuthToken> | undefined,
): DeviceAuthTokenSummary[] | undefined {
  if (!tokens) {
    return undefined;
  }
  const summaries = Object.values(tokens)
    .map((token) => ({
      role: token.role,
      scopes: token.scopes,
      createdAtMs: token.createdAtMs,
      rotatedAtMs: token.rotatedAtMs,
      revokedAtMs: token.revokedAtMs,
      lastUsedAtMs: token.lastUsedAtMs,
    }))
    .toSorted((a, b) => a.role.localeCompare(b.role));
  return summaries.length > 0 ? summaries : undefined;
}

export async function verifyDeviceToken(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
}): Promise<{ ok: boolean; reason?: string }> {
  const device = getPairedDeviceFromDb(normalizeDeviceId(params.deviceId));
  if (!device) {
    return { ok: false, reason: "device-not-paired" };
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return { ok: false, reason: "role-missing" };
  }
  const entry = device.tokens?.[role];
  if (!entry) {
    return { ok: false, reason: "token-missing" };
  }
  if (entry.revokedAtMs) {
    return { ok: false, reason: "token-revoked" };
  }
  if (!verifyPairingToken(params.token, entry.token)) {
    return { ok: false, reason: "token-mismatch" };
  }
  const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
  if (!roleScopesAllow({ role, requestedScopes, allowedScopes: entry.scopes })) {
    return { ok: false, reason: "scope-mismatch" };
  }
  // Update lastUsedAtMs
  upsertPairedDeviceInDb({
    ...device,
    tokens: { ...device.tokens, [role]: { ...entry, lastUsedAtMs: Date.now() } },
  });
  return { ok: true };
}

export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes: string[];
}): Promise<DeviceAuthToken | null> {
  const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
  const device = getPairedDeviceFromDb(normalizeDeviceId(params.deviceId));
  if (!device) {
    return null;
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return null;
  }
  const tokens = cloneDeviceTokens(device);
  const existing = tokens[role];
  if (existing && !existing.revokedAtMs) {
    if (roleScopesAllow({ role, requestedScopes, allowedScopes: existing.scopes })) {
      return existing;
    }
  }
  const now = Date.now();
  const next = buildDeviceAuthToken({
    role,
    scopes: requestedScopes,
    existing,
    now,
    rotatedAtMs: existing ? now : undefined,
  });
  tokens[role] = next;
  upsertPairedDeviceInDb({ ...device, tokens });
  return next;
}

export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
}): Promise<DeviceAuthToken | null> {
  const device = getPairedDeviceFromDb(normalizeDeviceId(params.deviceId));
  if (!device) {
    return null;
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return null;
  }
  const tokens = cloneDeviceTokens(device);
  const existing = tokens[role];
  const requestedScopes = normalizeDeviceAuthScopes(
    params.scopes ?? existing?.scopes ?? device.scopes,
  );
  const approvedScopes = normalizeDeviceAuthScopes(
    device.approvedScopes ?? device.scopes ?? existing?.scopes,
  );
  if (!scopesAllowWithImplications(requestedScopes, approvedScopes)) {
    return null;
  }
  const now = Date.now();
  const next = buildDeviceAuthToken({
    role,
    scopes: requestedScopes,
    existing,
    now,
    rotatedAtMs: now,
  });
  tokens[role] = next;
  upsertPairedDeviceInDb({ ...device, tokens });
  return next;
}

export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
}): Promise<DeviceAuthToken | null> {
  const device = getPairedDeviceFromDb(normalizeDeviceId(params.deviceId));
  if (!device) {
    return null;
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return null;
  }
  if (!device.tokens?.[role]) {
    return null;
  }
  const tokens = { ...device.tokens };
  const entry = { ...tokens[role], revokedAtMs: Date.now() };
  tokens[role] = entry;
  upsertPairedDeviceInDb({ ...device, tokens });
  return entry;
}

export async function clearDevicePairing(deviceId: string): Promise<boolean> {
  return deletePairedDeviceFromDb(normalizeDeviceId(deviceId));
}
