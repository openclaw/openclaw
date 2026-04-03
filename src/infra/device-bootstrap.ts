import path from "node:path";
import {
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
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
  profile?: DeviceBootstrapProfile;
  redeemedProfile?: DeviceBootstrapProfile;
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

function resolvePersistedBootstrapProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile(record.profile ?? record);
}

function resolvePersistedRedeemedProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile(record.redeemedProfile);
}

function resolveIssuedBootstrapProfile(params: {
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
}): DeviceBootstrapProfile {
  if (params.profile) {
    return normalizeDeviceBootstrapProfile(params.profile);
  }
  if (params.roles || params.scopes) {
    return normalizeDeviceBootstrapProfile({
      roles: params.roles,
      scopes: params.scopes,
    });
  }
  return PAIRING_SETUP_BOOTSTRAP_PROFILE;
}

function bootstrapProfileAllowsRequest(params: {
  allowedProfile: DeviceBootstrapProfile;
  requestedRole: string;
  requestedScopes: readonly string[];
}): boolean {
  return (
    params.allowedProfile.roles.includes(params.requestedRole) &&
    roleScopesAllow({
      role: params.requestedRole,
      requestedScopes: params.requestedScopes,
      allowedScopes: params.allowedProfile.scopes,
    })
  );
}

function resolveBootstrapProfileScopes(role: string, scopes: readonly string[]): string[] {
  if (role === "operator") {
    return scopes.filter((scope) => scope.startsWith("operator."));
  }
  return scopes.filter((scope) => !scope.startsWith("operator."));
}

function bootstrapProfileSatisfiesProfile(params: {
  actualProfile: DeviceBootstrapProfile;
  requiredProfile: DeviceBootstrapProfile;
}): boolean {
  for (const requiredRole of params.requiredProfile.roles) {
    if (!params.actualProfile.roles.includes(requiredRole)) {
      return false;
    }
    const requiredScopes = resolveBootstrapProfileScopes(
      requiredRole,
      params.requiredProfile.scopes,
    );
    if (
      requiredScopes.length > 0 &&
      !bootstrapProfileAllowsRequest({
        allowedProfile: params.actualProfile,
        requestedRole: requiredRole,
        requestedScopes: requiredScopes,
      })
    ) {
      return false;
    }
  }
  return true;
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
    const profile = resolvePersistedBootstrapProfile(record);
    state[tokenKey] = {
      token,
      profile,
      redeemedProfile: resolvePersistedRedeemedProfile(record),
      deviceId: typeof record.deviceId === "string" ? record.deviceId : undefined,
      publicKey: typeof record.publicKey === "string" ? record.publicKey : undefined,
      issuedAtMs,
      ts: typeof record.ts === "number" ? record.ts : issuedAtMs,
      lastUsedAtMs: typeof record.lastUsedAtMs === "number" ? record.lastUsedAtMs : undefined,
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
    profile?: DeviceBootstrapProfileInput;
    roles?: readonly string[];
    scopes?: readonly string[];
  } = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const token = generatePairingToken();
    const issuedAtMs = Date.now();
    const profile = resolveIssuedBootstrapProfile(params);
    state[token] = {
      token,
      ts: issuedAtMs,
      profile,
      redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
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

export async function getDeviceBootstrapTokenProfile(params: {
  token: string;
  baseDir?: string;
}): Promise<DeviceBootstrapProfile | null> {
  return await withLock(async () => {
    const providedToken = params.token.trim();
    if (!providedToken) {
      return null;
    }
    const state = await loadState(params.baseDir);
    const found = Object.values(state).find((candidate) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    return found ? resolvePersistedBootstrapProfile(found) : null;
  });
}

export async function redeemDeviceBootstrapTokenProfile(params: {
  token: string;
  role: string;
  scopes: readonly string[];
  baseDir?: string;
}): Promise<{ recorded: boolean; fullyRedeemed: boolean }> {
  return await withLock(async () => {
    const providedToken = params.token.trim();
    if (!providedToken) {
      return { recorded: false, fullyRedeemed: false };
    }
    const state = await loadState(params.baseDir);
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return { recorded: false, fullyRedeemed: false };
    }
    const [tokenKey, record] = found;
    const issuedProfile = resolvePersistedBootstrapProfile(record);
    const redeemedProfile = normalizeDeviceBootstrapProfile({
      roles: [...resolvePersistedRedeemedProfile(record).roles, params.role],
      scopes: [
        ...resolvePersistedRedeemedProfile(record).scopes,
        ...resolveBootstrapProfileScopes(params.role, params.scopes),
      ],
    });
    state[tokenKey] = {
      ...record,
      profile: issuedProfile,
      redeemedProfile,
    };
    await persistState(state, params.baseDir);
    return {
      recorded: true,
      fullyRedeemed: bootstrapProfileSatisfiesProfile({
        actualProfile: redeemedProfile,
        requiredProfile: issuedProfile,
      }),
    };
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
    const allowedProfile = resolvePersistedBootstrapProfile(record);
    // Fail closed for any attempt to redeem the token outside the issued
    // role/scope allowlist before binding it to a concrete device identity.
    if (
      allowedProfile.roles.length === 0 ||
      !bootstrapProfileAllowsRequest({
        allowedProfile,
        requestedRole: role,
        requestedScopes: params.scopes,
      })
    ) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }

    const boundDeviceId = record.deviceId?.trim();
    const boundPublicKey = record.publicKey?.trim();
    if (boundDeviceId || boundPublicKey) {
      if (boundDeviceId !== deviceId || boundPublicKey !== publicKey) {
        return { ok: false, reason: "bootstrap_token_invalid" };
      }
      state[tokenKey] = {
        ...record,
        profile: allowedProfile,
        deviceId,
        publicKey,
        lastUsedAtMs: Date.now(),
      };
      await persistState(state, params.baseDir);
      return { ok: true };
    }

    state[tokenKey] = {
      ...record,
      profile: allowedProfile,
      deviceId,
      publicKey,
      lastUsedAtMs: Date.now(),
    };
    await persistState(state, params.baseDir);
    return { ok: true };
  });
}
