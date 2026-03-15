import path from "node:path";
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "../shared/device-auth.js";
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
    role?: string;
    scopes?: readonly string[];
  } = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const token = generatePairingToken();
    const issuedAtMs = Date.now();
    const role = params.role?.trim();
    const scopes = normalizeDeviceAuthScopes(
      Array.isArray(params.scopes) ? [...params.scopes] : undefined,
    );
    state[token] = {
      token,
      ts: issuedAtMs,
      issuedAtMs,
      ...(role ? { roles: [normalizeDeviceAuthRole(role)] } : {}),
      ...(scopes.length > 0 || Array.isArray(params.scopes) ? { scopes } : {}),
    };
    await persistState(state, params.baseDir);
    return { token, expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS };
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
    const entry = Object.values(state).find((candidate) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!entry) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }

    const deviceId = params.deviceId.trim();
    const publicKey = params.publicKey.trim();
    const role = normalizeDeviceAuthRole(params.role);
    const requestedScopes = normalizeDeviceAuthScopes([...params.scopes]);
    if (!deviceId || !publicKey || !role) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const allowedRoles = Array.isArray(entry.roles)
      ? entry.roles.map((value) => normalizeDeviceAuthRole(String(value))).filter(Boolean)
      : [];
    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    if (Array.isArray(entry.scopes)) {
      const allowedScopes = normalizeDeviceAuthScopes(entry.scopes);
      if (
        allowedScopes.length !== requestedScopes.length ||
        allowedScopes.some((value, index) => value !== requestedScopes[index])
      ) {
        return { ok: false, reason: "bootstrap_token_invalid" };
      }
    }

    // Bootstrap setup codes are single-use. Consume the record before returning
    // success so the same token cannot be replayed to mutate a pending request.
    delete state[entry.token];
    await persistState(state, params.baseDir);
    return { ok: true };
  });
}
