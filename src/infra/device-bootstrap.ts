import path from "node:path";
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

function mergeRoles(existing: string[] | undefined, role: string): string[] {
  const out = new Set<string>(existing ?? []);
  const trimmed = role.trim();
  if (trimmed) {
    out.add(trimmed);
  }
  return [...out];
}

function mergeScopes(
  existing: string[] | undefined,
  scopes: readonly string[],
): string[] | undefined {
  const out = new Set<string>(existing ?? []);
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return out.size > 0 ? [...out] : undefined;
}

function resolveBootstrapPath(baseDir?: string): string {
  return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}

async function loadState(baseDir?: string): Promise<DeviceBootstrapStateFile> {
  const bootstrapPath = resolveBootstrapPath(baseDir);
  const state = (await readJsonFile<DeviceBootstrapStateFile>(bootstrapPath)) ?? {};
  for (const entry of Object.values(state)) {
    if (typeof entry.ts !== "number") {
      entry.ts = entry.issuedAtMs;
    }
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
  } = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const token = generatePairingToken();
    const issuedAtMs = Date.now();
    state[token] = {
      token,
      ts: issuedAtMs,
      issuedAtMs,
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
    const role = params.role.trim();
    if (!deviceId || !publicKey || !role) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }

    if (entry.deviceId && entry.deviceId !== deviceId) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    if (entry.publicKey && entry.publicKey !== publicKey) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }

    entry.deviceId = deviceId;
    entry.publicKey = publicKey;
    entry.roles = mergeRoles(entry.roles, role);
    entry.scopes = mergeScopes(entry.scopes, params.scopes);
    entry.lastUsedAtMs = Date.now();
    state[entry.token] = entry;
    await persistState(state, params.baseDir);
    return { ok: true };
  });
}
