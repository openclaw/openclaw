import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { loadSignedPolicy } from "./policy.load.js";
import type { SignedPolicy } from "./policy.schema.js";

const POLICY_CACHE_TTL_MS = 5_000;

export type ResolvedPolicyRuntimeConfig = {
  enabled: boolean;
  policyPath: string;
  sigPath: string;
  statePath: string;
  publicKey: string;
  publicKeys: Record<string, string>;
  failClosed: boolean;
  strictFilePermissions: boolean;
  enforceMonotonicSerial: boolean;
};

export type PolicyManagerState = {
  enabled: boolean;
  valid: boolean;
  lockdown: boolean;
  failClosed: boolean;
  policyPath: string;
  sigPath: string;
  statePath: string;
  publicKey: string;
  publicKeys: Record<string, string>;
  strictFilePermissions: boolean;
  enforceMonotonicSerial: boolean;
  verifiedKeyId?: string;
  lastAcceptedSerial?: number;
  policy?: SignedPolicy;
  reason?: string;
};

type PersistedPolicyState = {
  lastAcceptedSerial: number;
  updatedAt: string;
  policyHash: string;
  keyId?: string;
};

type PolicyStateCache = {
  fingerprint: string;
  expiresAtMs: number;
  state: PolicyManagerState;
};

let cache: PolicyStateCache | null = null;

function normalizePathOrDefault(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  return resolveUserPath(trimmed);
}

function normalizePublicKeyMap(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  const normalized = Object.entries(raw)
    .map(([keyId, key]) => [keyId.trim(), key.trim()] as const)
    .filter(([keyId, key]) => Boolean(keyId) && Boolean(key))
    .toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(normalized);
}

function isPosixLikePlatform(): boolean {
  return process.platform !== "win32";
}

function statHasUnsafeWriteBits(stats: Stats): boolean {
  const mode = stats.mode & 0o777;
  return (mode & 0o022) !== 0;
}

function ensureOwnerIsCurrentUser(stats: Stats): boolean {
  if (typeof process.getuid !== "function") {
    return true;
  }
  return stats.uid === process.getuid();
}

async function validateSecurePath(pathname: string): Promise<string | null> {
  let fileStats: Stats;
  try {
    fileStats = await fs.lstat(pathname);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return `failed to read metadata for ${pathname}: ${String(err)}`;
  }

  if (!fileStats.isFile()) {
    return `${pathname} must be a regular file`;
  }
  if (fileStats.isSymbolicLink()) {
    return `${pathname} must not be a symbolic link`;
  }
  if (statHasUnsafeWriteBits(fileStats)) {
    return `${pathname} has insecure permissions (group/world writable)`;
  }
  if (!ensureOwnerIsCurrentUser(fileStats)) {
    return `${pathname} is not owned by the current user`;
  }

  let parentStats: Stats;
  try {
    parentStats = await fs.stat(path.dirname(pathname));
  } catch (err) {
    return `failed to stat parent directory of ${pathname}: ${String(err)}`;
  }
  if (statHasUnsafeWriteBits(parentStats)) {
    return `${path.dirname(pathname)} has insecure permissions (group/world writable)`;
  }
  if (!ensureOwnerIsCurrentUser(parentStats)) {
    return `${path.dirname(pathname)} is not owned by the current user`;
  }

  return null;
}

function hashPolicyPayload(rawPolicy: string): string {
  return crypto.createHash("sha256").update(rawPolicy, "utf8").digest("hex");
}

async function readPersistedPolicyState(params: {
  statePath: string;
  strictFilePermissions: boolean;
}): Promise<{ state: PersistedPolicyState | null; error?: string }> {
  if (params.strictFilePermissions && isPosixLikePlatform()) {
    const securePathError = await validateSecurePath(params.statePath);
    if (securePathError) {
      return { state: null, error: `policy state file insecure: ${securePathError}` };
    }
  }

  let raw: string;
  try {
    raw = await fs.readFile(params.statePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { state: null };
    }
    return { state: null, error: `failed to read policy state file: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: null, error: `policy state file JSON parse failed: ${String(err)}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { state: null, error: "policy state file must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.lastAcceptedSerial !== "number" ||
    !Number.isInteger(obj.lastAcceptedSerial) ||
    obj.lastAcceptedSerial < 0
  ) {
    return { state: null, error: "policy state file has invalid lastAcceptedSerial" };
  }
  if (typeof obj.updatedAt !== "string" || !obj.updatedAt.trim()) {
    return { state: null, error: "policy state file has invalid updatedAt" };
  }
  if (typeof obj.policyHash !== "string" || !obj.policyHash.trim()) {
    return { state: null, error: "policy state file has invalid policyHash" };
  }
  if (obj.keyId != null && typeof obj.keyId !== "string") {
    return { state: null, error: "policy state file has invalid keyId" };
  }
  return {
    state: {
      lastAcceptedSerial: obj.lastAcceptedSerial,
      updatedAt: obj.updatedAt,
      policyHash: obj.policyHash,
      keyId: typeof obj.keyId === "string" ? obj.keyId : undefined,
    },
  };
}

async function writePersistedPolicyState(params: {
  statePath: string;
  strictFilePermissions: boolean;
  state: PersistedPolicyState;
}): Promise<string | null> {
  const dirPath = path.dirname(params.statePath);
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    return `failed to create policy state directory ${dirPath}: ${String(err)}`;
  }

  if (params.strictFilePermissions && isPosixLikePlatform()) {
    let dirStats: Stats;
    try {
      dirStats = await fs.stat(dirPath);
    } catch (err) {
      return `failed to stat policy state directory ${dirPath}: ${String(err)}`;
    }
    if (statHasUnsafeWriteBits(dirStats)) {
      return `${dirPath} has insecure permissions (group/world writable)`;
    }
    if (!ensureOwnerIsCurrentUser(dirStats)) {
      return `${dirPath} is not owned by the current user`;
    }
  }

  const tempPath = `${params.statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(params.state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, params.statePath);
    if (params.strictFilePermissions && isPosixLikePlatform()) {
      await fs.chmod(params.statePath, 0o600);
    }
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    return `failed to persist policy state file ${params.statePath}: ${String(err)}`;
  }

  return null;
}

export function resolvePolicyRuntimeConfig(config?: OpenClawConfig): ResolvedPolicyRuntimeConfig {
  const cfg = config ?? loadConfig();
  const stateDir = resolveStateDir();
  const policy = cfg.policy;
  return {
    enabled: policy?.enabled === true,
    policyPath: normalizePathOrDefault(policy?.policyPath, path.join(stateDir, "POLICY.json")),
    sigPath: normalizePathOrDefault(policy?.sigPath, path.join(stateDir, "POLICY.sig")),
    statePath: normalizePathOrDefault(policy?.statePath, path.join(stateDir, "POLICY.state.json")),
    publicKey: policy?.publicKey?.trim() ?? "",
    publicKeys: normalizePublicKeyMap(policy?.publicKeys),
    failClosed: policy?.failClosed !== false,
    strictFilePermissions: policy?.strictFilePermissions !== false,
    enforceMonotonicSerial: policy?.enforceMonotonicSerial !== false,
  };
}

function isExpiredPolicy(policy: SignedPolicy, nowMs: number): boolean {
  const expiresAt = policy.expiresAt?.trim();
  if (!expiresAt) {
    return false;
  }
  const expiryTs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryTs)) {
    return false;
  }
  return nowMs > expiryTs;
}

async function computePolicyState(
  config: ResolvedPolicyRuntimeConfig,
): Promise<PolicyManagerState> {
  const baseState: PolicyManagerState = {
    enabled: config.enabled,
    valid: true,
    lockdown: false,
    failClosed: config.failClosed,
    policyPath: config.policyPath,
    sigPath: config.sigPath,
    statePath: config.statePath,
    publicKey: config.publicKey,
    publicKeys: config.publicKeys,
    strictFilePermissions: config.strictFilePermissions,
    enforceMonotonicSerial: config.enforceMonotonicSerial,
  };

  if (!config.enabled) {
    return baseState;
  }

  const hasSingleKey = Boolean(config.publicKey);
  const hasKeySet = Object.keys(config.publicKeys).length > 0;
  if (!hasSingleKey && !hasKeySet) {
    return {
      ...baseState,
      valid: false,
      lockdown: config.failClosed,
      reason: "policy publicKey or policy.publicKeys is required when policy.enabled=true",
    };
  }

  const loaded = await loadSignedPolicy({
    policyPath: config.policyPath,
    sigPath: config.sigPath,
    publicKey: config.publicKey,
    publicKeys: config.publicKeys,
    strictFilePermissions: config.strictFilePermissions,
  });

  if (!loaded.ok) {
    return {
      ...baseState,
      valid: false,
      lockdown: config.failClosed,
      reason: loaded.error,
    };
  }

  const persistedState = await readPersistedPolicyState({
    statePath: config.statePath,
    strictFilePermissions: config.strictFilePermissions,
  });
  if (persistedState.error) {
    return {
      ...baseState,
      valid: false,
      lockdown: config.failClosed,
      reason: persistedState.error,
    };
  }

  const lastAcceptedSerial = persistedState.state?.lastAcceptedSerial;
  const hasLastAcceptedSerial =
    typeof lastAcceptedSerial === "number" && Number.isFinite(lastAcceptedSerial);
  if (config.enforceMonotonicSerial && hasLastAcceptedSerial) {
    const acceptedSerial = lastAcceptedSerial;
    if (loaded.policy.policySerial == null) {
      return {
        ...baseState,
        valid: false,
        lockdown: config.failClosed,
        reason: `policySerial is required after anti-rollback state is established (last accepted serial ${acceptedSerial})`,
      };
    }
    if (loaded.policy.policySerial < acceptedSerial) {
      return {
        ...baseState,
        valid: false,
        lockdown: config.failClosed,
        reason: `policy rollback detected: policySerial ${loaded.policy.policySerial} < ${acceptedSerial}`,
      };
    }
  }

  let nextAcceptedSerial =
    typeof lastAcceptedSerial === "number" && Number.isFinite(lastAcceptedSerial)
      ? lastAcceptedSerial
      : undefined;
  if (config.enforceMonotonicSerial && loaded.policy.policySerial != null) {
    const candidate = loaded.policy.policySerial;
    if (nextAcceptedSerial == null || candidate > nextAcceptedSerial) {
      nextAcceptedSerial = candidate;
      const writeError = await writePersistedPolicyState({
        statePath: config.statePath,
        strictFilePermissions: config.strictFilePermissions,
        state: {
          lastAcceptedSerial: candidate,
          updatedAt: new Date().toISOString(),
          policyHash: hashPolicyPayload(loaded.rawPolicy),
          keyId: loaded.verifiedKeyId,
        },
      });
      if (writeError) {
        return {
          ...baseState,
          valid: false,
          lockdown: config.failClosed,
          reason: writeError,
        };
      }
    }
  }

  if (isExpiredPolicy(loaded.policy, Date.now())) {
    return {
      ...baseState,
      valid: false,
      lockdown: config.failClosed,
      reason: `policy expired at ${loaded.policy.expiresAt}`,
    };
  }

  return {
    ...baseState,
    valid: true,
    lockdown: false,
    verifiedKeyId: loaded.verifiedKeyId,
    lastAcceptedSerial: nextAcceptedSerial,
    policy: loaded.policy,
  };
}

function buildFingerprint(config: ResolvedPolicyRuntimeConfig): string {
  return JSON.stringify([
    config.enabled,
    config.policyPath,
    config.sigPath,
    config.statePath,
    config.publicKey,
    Object.entries(config.publicKeys),
    config.failClosed,
    config.strictFilePermissions,
    config.enforceMonotonicSerial,
  ]);
}

export async function getPolicyManagerState(opts?: {
  config?: OpenClawConfig;
  forceReload?: boolean;
}): Promise<PolicyManagerState> {
  const resolved = resolvePolicyRuntimeConfig(opts?.config);
  const fingerprint = buildFingerprint(resolved);
  const nowMs = Date.now();
  if (
    !opts?.forceReload &&
    cache &&
    cache.fingerprint === fingerprint &&
    cache.expiresAtMs > nowMs
  ) {
    return cache.state;
  }
  const state = await computePolicyState(resolved);
  cache = {
    fingerprint,
    expiresAtMs: nowMs + POLICY_CACHE_TTL_MS,
    state,
  };
  return state;
}

export async function refreshPolicyManager(opts?: {
  config?: OpenClawConfig;
}): Promise<PolicyManagerState> {
  return await getPolicyManagerState({ config: opts?.config, forceReload: true });
}

export function clearPolicyManagerCacheForTests(): void {
  cache = null;
}
