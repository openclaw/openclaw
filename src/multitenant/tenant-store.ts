import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import {
  generatePlatformApiKey,
  hashApiKey,
  encryptSecret,
  decryptSecret,
  resolveMasterKey,
} from "./tenant-crypto.js";
import {
  resolveTenantStorePath,
  resolveTenantStoreDir,
  resolveTenantAgentDir,
  resolveTenantWorkspaceDir,
  resolveTenantSessionsDir,
} from "./tenant-paths.js";

// ── Types ──────────────────────────────────────────────────────────

export type Tenant = {
  id: string;
  name: string;
  platformApiKeyHash: string;
  llmProvider: string;
  /** Encrypted LLM API key (AES-256-GCM). */
  llmApiKeyEncrypted: string;
  status: "active" | "suspended";
  createdAt: number;
  updatedAt: number;
};

export type TenantStore = {
  version: number;
  tenants: Record<string, Tenant>;
  /** Reverse index: SHA-256(platformApiKey) → tenantId for O(1) lookup. */
  keyIndex: Record<string, string>;
};

export type CreateTenantParams = {
  name: string;
  llmProvider?: string;
  llmApiKey: string;
};

export type CreateTenantResult = {
  tenant: Tenant;
  /** Plaintext platform API key — returned only at creation time. */
  platformApiKey: string;
};

// ── Constants ──────────────────────────────────────────────────────

const TENANT_STORE_VERSION = 1;
const LOCK_OPTIONS = {
  retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
  stale: 10_000,
};

// ── Store I/O ──────────────────────────────────────────────────────

function loadTenantStore(env?: NodeJS.ProcessEnv): TenantStore {
  const raw = loadJsonFile(resolveTenantStorePath(env));
  if (raw && typeof raw === "object" && "tenants" in (raw as Record<string, unknown>)) {
    return raw as TenantStore;
  }
  return { version: TENANT_STORE_VERSION, tenants: {}, keyIndex: {} };
}

function saveTenantStore(store: TenantStore, env?: NodeJS.ProcessEnv): void {
  saveJsonFile(resolveTenantStorePath(env), store);
}

function ensureTenantStoreDir(env?: NodeJS.ProcessEnv): void {
  const dir = resolveTenantStoreDir(env);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Ensure the tenant store file exists so `proper-lockfile` can lock it. */
function ensureTenantStoreFile(env?: NodeJS.ProcessEnv): string {
  ensureTenantStoreDir(env);
  const storePath = resolveTenantStorePath(env);
  if (!fs.existsSync(storePath)) {
    saveTenantStore({ version: TENANT_STORE_VERSION, tenants: {}, keyIndex: {} }, env);
  }
  return storePath;
}

// ── Locked mutation helper ─────────────────────────────────────────

async function withTenantStoreLock<T>(
  fn: (store: TenantStore) => T,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const storePath = ensureTenantStoreFile(env);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(storePath, LOCK_OPTIONS);
    const store = loadTenantStore(env);
    const result = fn(store);
    saveTenantStore(store, env);
    return result;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

// ── Tenant directory provisioning ──────────────────────────────────

function ensureTenantDirectories(tenantId: string, env?: NodeJS.ProcessEnv): void {
  const dirs = [
    resolveTenantAgentDir(tenantId, env),
    resolveTenantWorkspaceDir(tenantId, env),
    resolveTenantSessionsDir(tenantId, env),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

export async function createTenant(
  params: CreateTenantParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreateTenantResult> {
  const masterKey = resolveMasterKey(env);
  if (!masterKey) {
    throw new Error("OPENCLAW_TENANT_MASTER_KEY is required for multi-tenant mode.");
  }

  const id = randomUUID();
  const platformApiKey = generatePlatformApiKey();
  const keyHash = hashApiKey(platformApiKey);
  const now = Date.now();

  const tenant: Tenant = {
    id,
    name: params.name.trim(),
    platformApiKeyHash: keyHash,
    llmProvider: params.llmProvider?.trim() || "anthropic",
    llmApiKeyEncrypted: encryptSecret(params.llmApiKey, masterKey),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  await withTenantStoreLock((store) => {
    store.tenants[id] = tenant;
    store.keyIndex[keyHash] = id;
  }, env);

  // Provision tenant directories
  ensureTenantDirectories(id, env);

  // Write auth profile store with their LLM key
  writeTenantAuthProfile(tenant, params.llmApiKey, env);

  return { tenant, platformApiKey };
}

export async function listTenants(env: NodeJS.ProcessEnv = process.env): Promise<Tenant[]> {
  const store = loadTenantStore(env);
  return Object.values(store.tenants);
}

export async function getTenant(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Tenant | undefined> {
  const store = loadTenantStore(env);
  return store.tenants[tenantId];
}

export async function getTenantByApiKeyHash(
  keyHash: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Tenant | undefined> {
  const store = loadTenantStore(env);
  const tenantId = store.keyIndex[keyHash];
  if (!tenantId) {
    return undefined;
  }
  return store.tenants[tenantId];
}

export async function updateTenant(
  tenantId: string,
  updates: { name?: string; llmApiKey?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Tenant | undefined> {
  const masterKey = resolveMasterKey(env);
  if (!masterKey) {
    throw new Error("OPENCLAW_TENANT_MASTER_KEY is required for multi-tenant mode.");
  }

  let updated: Tenant | undefined;

  await withTenantStoreLock((store) => {
    const tenant = store.tenants[tenantId];
    if (!tenant) {
      return;
    }

    if (updates.name !== undefined) {
      tenant.name = updates.name.trim();
    }
    if (updates.llmApiKey !== undefined) {
      tenant.llmApiKeyEncrypted = encryptSecret(updates.llmApiKey, masterKey);
      // Also update the auth profile on disk
      writeTenantAuthProfile(tenant, updates.llmApiKey, env);
    }
    tenant.updatedAt = Date.now();
    updated = tenant;
  }, env);

  return updated;
}

export async function suspendTenant(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Tenant | undefined> {
  let updated: Tenant | undefined;

  await withTenantStoreLock((store) => {
    const tenant = store.tenants[tenantId];
    if (!tenant) {
      return;
    }

    tenant.status = "suspended";
    tenant.updatedAt = Date.now();
    updated = tenant;
  }, env);

  return updated;
}

/**
 * Decrypt a tenant's LLM API key.
 */
export function decryptTenantLlmKey(tenant: Tenant, env: NodeJS.ProcessEnv = process.env): string {
  const masterKey = resolveMasterKey(env);
  if (!masterKey) {
    throw new Error("OPENCLAW_TENANT_MASTER_KEY is required.");
  }
  return decryptSecret(tenant.llmApiKeyEncrypted, masterKey);
}

// ── Auth profile integration ───────────────────────────────────────

/**
 * Write the tenant's LLM API key into the standard auth-profiles.json
 * format so the existing agent pipeline picks it up automatically.
 */
function writeTenantAuthProfile(
  tenant: Tenant,
  llmApiKeyPlain: string,
  env?: NodeJS.ProcessEnv,
): void {
  const agentDir = resolveTenantAgentDir(tenant.id, env);
  const authProfilePath = path.join(agentDir, "auth-profiles.json");
  const profileId = `${tenant.llmProvider}:default`;

  const store = {
    version: 1,
    profiles: {
      [profileId]: {
        type: "api_key" as const,
        provider: tenant.llmProvider,
        key: llmApiKeyPlain,
      },
    },
  };
  saveJsonFile(authProfilePath, store);
}
