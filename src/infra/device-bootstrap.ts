import path from "node:path";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolvePairingPaths } from "./pairing-files.js";
import {
  createAsyncLock,
  pruneExpiredPending,
  readJsonFile,
  writeJsonAtomic,
} from "./pairing-files.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

export const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

export type DeviceBootstrapTokenRecord = {
  token: string;
  ts: number;
  deviceId?: string;
  publicKey?: string;
  roles?: string[];
  scopes?: string[];
  issuedAtMs: number;
  lastUsedAtMs?: number;
};

type DeviceBootstrapStateFile = Record<string, DeviceBootstrapTokenRecord>;

const withLock = createAsyncLock();

function normalizeBootstrapRoles(roles: readonly string[] | undefined): string[] {
  if (!Array.isArray(roles)) {
    return [];
  }
  const out = new Set<string>();
  for (const role of roles) {
    const trimmed = role.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return [...out].toSorted();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function resolveBootstrapPath(baseDir?: string): string {
  return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}

async function loadState(baseDir?: string): Promise<DeviceBootstrapStateFile> {
  const bootstrapPath = resolveBootstrapPath(baseDir);
  const rawState = (await readJsonFile<DeviceBootstrapStateFile>(bootstrapPath)) ?? {};
  const state: DeviceBootstrapStateFile = {};
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    return state;
  }
  for (const [tokenKey, entry] of Object.entries(rawState)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Partial<DeviceBootstrapTokenRecord>;
    const token =
      typeof record.token === "string" && record.token.trim().length > 0 ? record.token : tokenKey;
    const issuedAtMs = typeof record.issuedAtMs === "number" ? record.issuedAtMs : 0;
    state[tokenKey] = {
      ...record,
      token,
      issuedAtMs,
      ts: typeof record.ts === "number" ? record.ts : issuedAtMs,
    };
  }
  pruneExpiredPending(state, Date.now(), DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  return state;
}

async function persistState(state: DeviceBootstrapStateFile, baseDir?: string): Promise<void> {
  const bootstrapPath = resolveBootstrapPath(baseDir);
  await writeJsonAtomic(bootstrapPath, state);
}

export async function issueDeviceBootstrapToken(
  params: {
    baseDir?: string;
    roles?: readonly string[];
    scopes?: readonly string[];
  } = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const token = generatePairingToken();
    const issuedAtMs = Date.now();
    const roles = normalizeBootstrapRoles(params.roles ?? ["node"]);
    const scopes = normalizeDeviceAuthScopes(params.scopes ? [...params.scopes] : []);
    state[token] = {
      token,
      ts: issuedAtMs,
      roles,
      scopes,
      issuedAtMs,
    };
    await persistState(state, params.baseDir);
    return { token, expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS };
  });
}

export async function clearDeviceBootstrapTokens(
  params: {
    baseDir?: string;
  } = {},
): Promise<{ removed: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const removed = Object.keys(state).length;
    await persistState({}, params.baseDir);
    return { removed };
  });
}

export async function revokeDeviceBootstrapToken(params: {
  token: string;
  baseDir?: string;
}): Promise<{ removed: boolean }> {
  return await withLock(async () => {
    const providedToken = params.token.trim();
    if (!providedToken) {
      return { removed: false };
    }
    const state = await loadState(params.baseDir);
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return { removed: false };
    }
    delete state[found[0]];
    await persistState(state, params.baseDir);
    return { removed: true };
  });
}

export async function verifyDeviceBootstrapToken(params: {
  token: string;
  deviceId: string;
  publicKey: string;
  role: string;
  scopes: readonly string[];
  baseDir?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const providedToken = params.token.trim();
    if (!providedToken) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const [tokenKey, record] = found;

    const deviceId = params.deviceId.trim();
    const publicKey = params.publicKey.trim();
    const role = params.role.trim();
    if (!deviceId || !publicKey || !role) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const requestedRoles = normalizeBootstrapRoles([role]);
    const requestedScopes = normalizeDeviceAuthScopes([...params.scopes]);
    const allowedRoles = normalizeBootstrapRoles(record.roles);
    const allowedScopes = normalizeDeviceAuthScopes(record.scopes);
    // Fail closed for unbound legacy setup codes and for any attempt to redeem
    // the token outside the exact role/scope profile it was issued for.
    if (
      allowedRoles.length === 0 ||
      !sameStringSet(requestedRoles, allowedRoles) ||
      !sameStringSet(requestedScopes, allowedScopes)
    ) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }

    // Bootstrap setup codes are single-use. Consume the record before returning
    // success so the same token cannot be replayed to mutate a pending request.
    delete state[tokenKey];
    await persistState(state, params.baseDir);
    return { ok: true };
  });
}
