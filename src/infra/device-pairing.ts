import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type DevicePairingPendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
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

export type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  createdAtMs: number;
  approvedAtMs: number;
};

export type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};

type DevicePairingStateFile = {
  pendingById: Record<string, DevicePairingPendingRequest>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;

function resolvePaths(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, "devices");
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJSONAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // best-effort
  }
  await fs.rename(tmp, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function pruneExpiredPending(
  pendingById: Record<string, DevicePairingPendingRequest>,
  nowMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > PENDING_TTL_MS) {
      delete pendingById[id];
    }
  }
}

let lock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release: (() => void) | undefined;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

async function loadState(baseDir?: string): Promise<DevicePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  const [pending, paired] = await Promise.all([
    readJSON<Record<string, DevicePairingPendingRequest>>(pendingPath),
    readJSON<Record<string, PairedDevice>>(pairedPath),
  ]);
  const state: DevicePairingStateFile = {
    pendingById: pending ?? {},
    pairedByDeviceId: paired ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now());
  return state;
}

async function persistState(state: DevicePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  await Promise.all([
    writeJSONAtomic(pendingPath, state.pendingById),
    writeJSONAtomic(pairedPath, state.pairedByDeviceId),
  ]);
}

function normalizeDeviceId(deviceId: string) {
  return deviceId.trim();
}

function mergeRoles(...items: Array<string | string[] | undefined>): string[] | undefined {
  const roles = new Set<string>();
  for (const item of items) {
    if (!item) continue;
    if (Array.isArray(item)) {
      for (const role of item) {
        const trimmed = role.trim();
        if (trimmed) roles.add(trimmed);
      }
    } else {
      const trimmed = item.trim();
      if (trimmed) roles.add(trimmed);
    }
  }
  if (roles.size === 0) return undefined;
  return [...roles];
}

export async function listDevicePairing(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).sort((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).sort(
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
    const existing = Object.values(state.pendingById).find((p) => p.deviceId === deviceId);
    if (existing) {
      return { status: "pending", request: existing, created: false };
    }
    const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
    const request: DevicePairingPendingRequest = {
      requestId: randomUUID(),
      deviceId,
      publicKey: req.publicKey,
      displayName: req.displayName,
      platform: req.platform,
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
    state.pendingById[request.requestId] = request;
    await persistState(state, baseDir);
    return { status: "pending", request, created: true };
  });
}

export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; device: PairedDevice } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) return null;
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const device: PairedDevice = {
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      displayName: pending.displayName,
      platform: pending.platform,
      clientId: pending.clientId,
      clientMode: pending.clientMode,
      role: pending.role,
      roles,
      scopes: pending.scopes,
      remoteIp: pending.remoteIp,
      createdAtMs: existing?.createdAtMs ?? now,
      approvedAtMs: now,
    };
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir);
    return { requestId, device };
  });
}

export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; deviceId: string } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) return null;
    delete state.pendingById[requestId];
    await persistState(state, baseDir);
    return { requestId, deviceId: pending.deviceId };
  });
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<Omit<PairedDevice, "deviceId" | "createdAtMs" | "approvedAtMs">>,
  baseDir?: string,
): Promise<void> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const existing = state.pairedByDeviceId[normalizeDeviceId(deviceId)];
    if (!existing) return;
    const roles = mergeRoles(existing.roles, existing.role, patch.role);
    state.pairedByDeviceId[deviceId] = {
      ...existing,
      ...patch,
      deviceId: existing.deviceId,
      createdAtMs: existing.createdAtMs,
      approvedAtMs: existing.approvedAtMs,
      role: patch.role ?? existing.role,
      roles,
    };
    await persistState(state, baseDir);
  });
}
