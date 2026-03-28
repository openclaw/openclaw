import { randomUUID } from "node:crypto";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolveMissingRequestedScope, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  createAsyncLock,
  pruneExpiredPending,
  readJsonFile,
  resolvePairingPaths,
  writeJsonAtomic,
} from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

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

export type RotateDeviceTokenDenyReason =
  | "unknown-device-or-role"
  | "missing-approved-scope-baseline"
  | "scope-outside-approved-baseline";

export type RotateDeviceTokenResult =
  | { ok: true; entry: DeviceAuthToken }
  | { ok: false; reason: RotateDeviceTokenDenyReason };

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

export type ApproveDevicePairingResult =
  | { status: "approved"; requestId: string; device: PairedDevice }
  | { status: "forbidden"; missingScope: string }
  | null;

type DevicePairingStateFile = {
  pendingById: Record<string, DevicePairingPendingRequest>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const OPERATOR_SCOPE_PREFIX = "operator.";

const withLock = createAsyncLock();

async function loadState(baseDir?: string): Promise<DevicePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  const [pending, paired] = await Promise.all([
    readJsonFile<Record<string, DevicePairingPendingRequest>>(pendingPath),
    readJsonFile<Record<string, PairedDevice>>(pairedPath),
  ]);
  const state: DevicePairingStateFile = {
    pendingById: pending ?? {},
    pairedByDeviceId: paired ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}

async function persistState(state: DevicePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  await Promise.all([
    writeJsonAtomic(pendingPath, state.pendingById),
    writeJsonAtomic(pairedPath, state.pairedByDeviceId),
  ]);
}

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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  for (const value of left) {
    if (!rightSet.has(value)) {
      return false;
    }
  }
  return true;
}

function resolveRequestedRoles(input: { role?: string; roles?: string[] }): string[] {
  return mergeRoles(input.roles, input.role) ?? [];
}

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
  if (normalizeRole(existing.role) !== normalizeRole(incoming.role)) {
    return false;
  }
  if (
    !sameStringSet(resolveRequestedRoles(existing), resolveRequestedRoles(incoming)) ||
    !sameStringSet(resolveRequestedScopes(existing), resolveRequestedScopes(incoming))
  ) {
    return false;
  }
  return true;
}

function refreshPendingDevicePairingRequest(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  isRepair: boolean,
): DevicePairingPendingRequest {
  return {
    ...existing,
    publicKey: incoming.publicKey,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // If either request is interactive, keep the pending request visible for approval.
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    ts: Date.now(),
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

function buildPendingDevicePairingRequest(params: {
  requestId?: string;
  deviceId: string;
  isRepair: boolean;
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">;
}): DevicePairingPendingRequest {
  const role = normalizeRole(params.req.role) ?? undefined;
  return {
    requestId: params.requestId ?? randomUUID(),
    deviceId: params.deviceId,
    publicKey: params.req.publicKey,
    displayName: params.req.displayName,
    platform: params.req.platform,
    deviceFamily: params.req.deviceFamily,
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    role,
    roles: mergeRoles(params.req.roles, role),
    scopes: mergeScopes(params.req.scopes),
    remoteIp: params.req.remoteIp,
    silent: params.req.silent,
    isRepair: params.isRepair,
    ts: Date.now(),
  };
}

function resolvePendingApprovalRole(pending: DevicePairingPendingRequest): string | null {
  const role = normalizeRole(pending.role);
  if (role) {
    return role;
  }
  if (!Array.isArray(pending.roles)) {
    return null;
  }
  for (const candidate of pending.roles) {
    const normalized = normalizeRole(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function newToken() {
  return generatePairingToken();
}

function getPairedDeviceFromState(
  state: DevicePairingStateFile,
  deviceId: string,
): PairedDevice | null {
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
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

function resolveApprovedDeviceScopeBaseline(device: PairedDevice): string[] | null {
  const baseline = device.approvedScopes ?? device.scopes;
  if (!Array.isArray(baseline)) {
    return null;
  }
  return normalizeDeviceAuthScopes(baseline);
}

function scopesWithinApprovedDeviceBaseline(params: {
  role: string;
  scopes: readonly string[];
  approvedScopes: readonly string[] | null;
}): boolean {
  if (!params.approvedScopes) {
    return false;
  }
  return roleScopesAllow({
    role: params.role,
    requestedScopes: params.scopes,
    allowedScopes: params.approvedScopes,
  });
}

export async function listDevicePairing(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

export async function getPairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<PairedDevice | null> {
  const state = await loadState(baseDir);
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

export async function getPendingDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<DevicePairingPendingRequest | null> {
  const state = await loadState(baseDir);
  return state.pendingById[requestId] ?? null;
}

export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: DevicePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const deviceId = normalizeDeviceId(req.deviceId);
    if (!deviceId) {
      throw new Error("deviceId required");
    }
    const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
    const pendingForDevice = Object.values(state.pendingById)
      .filter((pending) => pending.deviceId === deviceId)
      .toSorted((left, right) => right.ts - left.ts);
    const latestPending = pendingForDevice[0];
    if (latestPending && pendingForDevice.length === 1) {
      if (samePendingApprovalSnapshot(latestPending, req)) {
        const refreshed = refreshPendingDevicePairingRequest(latestPending, req, isRepair);
        state.pendingById[latestPending.requestId] = refreshed;
        await persistState(state, baseDir);
        return { status: "pending" as const, request: refreshed, created: false };
      }
    }
    if (pendingForDevice.length > 0) {
      const mergedRoles = mergeRoles(
        ...pendingForDevice.flatMap((pending) => [pending.roles, pending.role]),
        req.roles,
        req.role,
      );
      const mergedScopes = mergeScopes(
        ...pendingForDevice.map((pending) => pending.scopes),
        req.scopes,
      );
      for (const pending of pendingForDevice) {
        delete state.pendingById[pending.requestId];
      }
      const superseded = buildPendingDevicePairingRequest({
        deviceId,
        isRepair,
        req: {
          ...req,
          role: normalizeRole(req.role) ?? latestPending?.role,
          roles: mergedRoles,
          scopes: mergedScopes,
          // Preserve interactive visibility when superseding pending requests:
          // if any previous pending request was interactive, keep this one interactive.
          silent: resolveSupersededPendingSilent({
            existing: pendingForDevice,
            incomingSilent: req.silent,
          }),
        },
      });
      state.pendingById[superseded.requestId] = superseded;
      await persistState(state, baseDir);
      return { status: "pending" as const, request: superseded, created: true };
    }

    const request = buildPendingDevicePairingRequest({
      deviceId,
      isRepair,
      req,
    });
    state.pendingById[request.requestId] = request;
    await persistState(state, baseDir);
    return { status: "pending" as const, request, created: true };
  });
}

export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  optionsOrBaseDir?: { callerScopes?: readonly string[] } | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options =
    typeof optionsOrBaseDir === "string" || optionsOrBaseDir === undefined
      ? undefined
      : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const approvalRole = resolvePendingApprovalRole(pending);
    if (approvalRole) {
      const requestedOperatorScopes = normalizeDeviceAuthScopes(pending.scopes).filter((scope) =>
        scope.startsWith(OPERATOR_SCOPE_PREFIX),
      );
      if (!options?.callerScopes) {
        return {
          status: "forbidden",
          missingScope: requestedOperatorScopes[0] ?? "callerScopes-required",
        };
      }
      const missingScope = resolveMissingRequestedScope({
        role: approvalRole,
        requestedScopes: requestedOperatorScopes,
        allowedScopes: options.callerScopes,
      });
      if (missingScope) {
        return { status: "forbidden", missingScope };
      }
    }
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const approvedScopes = mergeScopes(
      existing?.approvedScopes ?? existing?.scopes,
      pending.scopes,
    );
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    const roleForToken = normalizeRole(pending.role);
    if (roleForToken) {
      const existingToken = tokens[roleForToken];
      const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
      const nextScopes =
        requestedScopes.length > 0
          ? requestedScopes
          : normalizeDeviceAuthScopes(
              existingToken?.scopes ??
                approvedScopes ??
                existing?.approvedScopes ??
                existing?.scopes,
            );
      const now = Date.now();
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
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir);
    return { status: "approved", requestId, device };
  });
}

export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; deviceId: string } | null> {
  return await withLock(async () => {
    return await rejectPendingPairingRequest<
      DevicePairingPendingRequest,
      DevicePairingStateFile,
      "deviceId"
    >({
      requestId,
      idKey: "deviceId",
      loadState: () => loadState(baseDir),
      persistState: (state) => persistState(state, baseDir),
      getId: (pending: DevicePairingPendingRequest) => pending.deviceId,
    });
  });
}

export async function removePairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<{ deviceId: string } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized || !state.pairedByDeviceId[normalized]) {
      return null;
    }
    delete state.pairedByDeviceId[normalized];
    await persistState(state, baseDir);
    return { deviceId: normalized };
  });
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<
    Omit<PairedDevice, "deviceId" | "createdAtMs" | "approvedAtMs" | "approvedScopes">
  >,
  baseDir?: string,
): Promise<void> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const existing = state.pairedByDeviceId[normalizeDeviceId(deviceId)];
    if (!existing) {
      return;
    }
    const roles = mergeRoles(existing.roles, existing.role, patch.role);
    const scopes = mergeScopes(existing.scopes, patch.scopes);
    state.pairedByDeviceId[deviceId] = {
      ...existing,
      ...patch,
      deviceId: existing.deviceId,
      createdAtMs: existing.createdAtMs,
      approvedAtMs: existing.approvedAtMs,
      approvedScopes: existing.approvedScopes,
      role: patch.role ?? existing.role,
      roles,
      scopes,
    };
    await persistState(state, baseDir);
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
  baseDir?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const device = getPairedDeviceFromState(state, params.deviceId);
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
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: entry.scopes,
        approvedScopes,
      })
    ) {
      return { ok: false, reason: "scope-mismatch" };
    }
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    if (!roleScopesAllow({ role, requestedScopes, allowedScopes: entry.scopes })) {
      return { ok: false, reason: "scope-mismatch" };
    }
    entry.lastUsedAtMs = Date.now();
    device.tokens ??= {};
    device.tokens[role] = entry;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return { ok: true };
  });
}

export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context) {
      return null;
    }
    const { device, role, tokens, existing } = context;
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: requestedScopes,
        approvedScopes,
      })
    ) {
      return null;
    }
    if (existing && !existing.revokedAtMs) {
      const existingWithinApproved = scopesWithinApprovedDeviceBaseline({
        role,
        scopes: existing.scopes,
        approvedScopes,
      });
      if (
        existingWithinApproved &&
        roleScopesAllow({ role, requestedScopes, allowedScopes: existing.scopes })
      ) {
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
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return next;
  });
}

function resolveDeviceTokenUpdateContext(params: {
  state: DevicePairingStateFile;
  deviceId: string;
  role: string;
}): {
  device: PairedDevice;
  role: string;
  tokens: Record<string, DeviceAuthToken>;
  existing: DeviceAuthToken | undefined;
} | null {
  const device = getPairedDeviceFromState(params.state, params.deviceId);
  if (!device) {
    return null;
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return null;
  }
  const tokens = cloneDeviceTokens(device);
  const existing = tokens[role];
  return { device, role, tokens, existing };
}

export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  baseDir?: string;
}): Promise<RotateDeviceTokenResult> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const requestedScopes = normalizeDeviceAuthScopes(
      params.scopes ?? existing?.scopes ?? device.scopes,
    );
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (!approvedScopes) {
      return { ok: false, reason: "missing-approved-scope-baseline" };
    }
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: requestedScopes,
        approvedScopes,
      })
    ) {
      return { ok: false, reason: "scope-outside-approved-baseline" };
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
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return { ok: true, entry: next };
  });
}

export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
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
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, params.baseDir);
    return entry;
  });
}

export async function clearDevicePairing(deviceId: string, baseDir?: string): Promise<boolean> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalizedId = normalizeDeviceId(deviceId);
    if (!state.pairedByDeviceId[normalizedId]) {
      return false;
    }
    delete state.pairedByDeviceId[normalizedId];
    await persistState(state, baseDir);
    return true;
  });
}
