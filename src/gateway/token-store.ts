import fs from "node:fs";
import path from "node:path";
import { withFileLock, type FileLockOptions } from "../plugin-sdk/file-lock.js";
import type { OperatorScope } from "./method-scopes.js";
import type { GatewayRole } from "./role-policy.js";

const TOKEN_STORE_FILENAME = "token-store.json";
const TOKEN_STORE_DIR = "identity";

export type TokenMetadata = {
  jti: string;
  subject: string;
  role: GatewayRole;
  scopes: OperatorScope[];
  issuedAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  rotatedToJti?: string;
};

export type TokenStore = {
  version: 1;
  tokens: Record<string, TokenMetadata>;
};

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 3,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 2000,
    randomize: true,
  },
  stale: 10_000,
};

function resolveTokenStorePath(stateDir?: string): string {
  const base = stateDir ?? defaultStateDir();
  return path.join(base, TOKEN_STORE_DIR, TOKEN_STORE_FILENAME);
}

function defaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".openclaw");
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function emptyStore(): TokenStore {
  return { version: 1, tokens: {} };
}

export function loadTokenStore(stateDir?: string): TokenStore {
  const storePath = resolveTokenStorePath(stateDir);
  if (!fs.existsSync(storePath)) {
    return emptyStore();
  }
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.tokens !== "object" || parsed.tokens === null) {
      return emptyStore();
    }
    return parsed as unknown as TokenStore;
  } catch {
    return emptyStore();
  }
}

export function saveTokenStore(store: TokenStore, stateDir?: string): void {
  const storePath = resolveTokenStorePath(stateDir);
  ensureParentDir(storePath);
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export async function withTokenStoreLock<T>(
  stateDir: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const storePath = resolveTokenStorePath(stateDir);
  ensureParentDir(storePath);
  return withFileLock(storePath, DEFAULT_LOCK_OPTIONS, fn);
}

export function isTokenRevoked(store: TokenStore, jti: string): boolean {
  const meta = store.tokens[jti];
  if (!meta) {
    return false;
  }
  return meta.revokedAt !== undefined;
}

export function revokeToken(store: TokenStore, jti: string): TokenStore {
  const meta = store.tokens[jti];
  if (!meta) {
    return store;
  }
  return {
    ...store,
    tokens: {
      ...store.tokens,
      [jti]: { ...meta, revokedAt: Math.floor(Date.now() / 1000) },
    },
  };
}

export function revokeAllTokens(store: TokenStore): TokenStore {
  const now = Math.floor(Date.now() / 1000);
  const tokens: Record<string, TokenMetadata> = {};
  for (const [jti, meta] of Object.entries(store.tokens)) {
    tokens[jti] = meta.revokedAt ? meta : { ...meta, revokedAt: now };
  }
  return { ...store, tokens };
}

export function pruneExpiredTokens(store: TokenStore, now?: number): TokenStore {
  const cutoff = now ?? Math.floor(Date.now() / 1000);
  const tokens: Record<string, TokenMetadata> = {};
  for (const [jti, meta] of Object.entries(store.tokens)) {
    const expired = meta.expiresAt !== undefined && meta.expiresAt <= cutoff;
    const revoked = meta.revokedAt !== undefined;
    // Keep if not both expired and revoked (keep revoked entries for audit trail)
    if (!expired || !revoked) {
      tokens[jti] = meta;
    }
  }
  return { ...store, tokens };
}

export function recordTokenMetadata(store: TokenStore, meta: TokenMetadata): TokenStore {
  return {
    ...store,
    tokens: { ...store.tokens, [meta.jti]: meta },
  };
}

export function touchTokenLastUsed(store: TokenStore, jti: string): TokenStore {
  const meta = store.tokens[jti];
  if (!meta) {
    return store;
  }
  return {
    ...store,
    tokens: {
      ...store.tokens,
      [jti]: { ...meta, lastUsedAt: Math.floor(Date.now() / 1000) },
    },
  };
}
