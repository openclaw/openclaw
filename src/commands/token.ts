import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { ScopedTokenConfig } from "../config/types.gateway.js";
import type { OperatorScope } from "../gateway/method-scopes.js";
import type { GatewayRole } from "../gateway/role-policy.js";
import {
  createScopedToken,
  loadOrCreateSigningKey,
  parseScopedToken,
} from "../gateway/scoped-token.js";
import {
  loadTokenStore,
  pruneExpiredTokens,
  recordTokenMetadata,
  revokeAllTokens,
  revokeToken,
  saveTokenStore,
  type TokenMetadata,
} from "../gateway/token-store.js";

function resolveSigningKeyPath(cfg: ScopedTokenConfig | undefined, stateDir: string): string {
  return cfg?.signingKeyPath ?? path.join(stateDir, "identity", "token-signing.key");
}

function parseTtl(raw: string): number {
  const match = raw.match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`Invalid TTL format: "${raw}". Use e.g. 3600, 1h, 30d.`);
  }
  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? "s").toLowerCase();
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit] ?? 1);
}

const VALID_SCOPES: ReadonlySet<string> = new Set([
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
]);

function parseScopes(raw: string): OperatorScope[] {
  const scopes = raw.split(",").map((s) => {
    const trimmed = s.trim();
    return trimmed.startsWith("operator.") ? trimmed : `operator.${trimmed}`;
  });
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope)) {
      throw new Error(`Unknown scope: "${scope}". Valid: ${[...VALID_SCOPES].join(", ")}`);
    }
  }
  return scopes as OperatorScope[];
}

export type TokenCreateParams = {
  subject: string;
  scopes: string;
  ttl?: string;
  role?: string;
  methods?: string;
  scopedTokenConfig?: ScopedTokenConfig;
  stateDir?: string;
};

export function tokenCreate(params: TokenCreateParams): {
  tokenString: string;
  jti: string;
  subject: string;
  role: GatewayRole;
  scopes: OperatorScope[];
  expiresAt?: number;
} {
  const stateDir = params.stateDir ?? resolveStateDir();
  const cfg = params.scopedTokenConfig;
  const keyPath = resolveSigningKeyPath(cfg, stateDir);
  const signingKey = loadOrCreateSigningKey(keyPath);

  const scopes = parseScopes(params.scopes);
  const role: GatewayRole = params.role === "node" ? "node" : "operator";
  const defaultTtl = cfg?.defaultTtlSeconds ?? 86_400;
  const maxTtl = cfg?.maxTtlSeconds ?? 2_592_000;
  const ttlSeconds = params.ttl ? parseTtl(params.ttl) : defaultTtl;

  if (ttlSeconds > maxTtl) {
    throw new Error(
      `TTL ${ttlSeconds}s exceeds maximum ${maxTtl}s. Reduce --ttl or raise maxTtlSeconds.`,
    );
  }

  const methods = params.methods
    ? params.methods
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : undefined;

  const tokenString = createScopedToken({
    signingKey,
    subject: params.subject,
    role,
    scopes,
    methods,
    ttlSeconds,
  });

  const parsed = parseScopedToken(tokenString)!;

  // Record in token store
  let store = loadTokenStore(stateDir);
  const meta: TokenMetadata = {
    jti: parsed.jti,
    subject: params.subject,
    role,
    scopes,
    issuedAt: parsed.iat,
    expiresAt: parsed.exp,
  };
  store = recordTokenMetadata(store, meta);
  saveTokenStore(store, stateDir);

  return {
    tokenString,
    jti: parsed.jti,
    subject: params.subject,
    role,
    scopes,
    expiresAt: parsed.exp,
  };
}

export type TokenListEntry = {
  jti: string;
  subject: string;
  role: string;
  scopes: string[];
  issuedAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  status: "active" | "expired" | "revoked";
};

export function tokenList(params?: { stateDir?: string }): TokenListEntry[] {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const store = loadTokenStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const entries: TokenListEntry[] = [];

  for (const meta of Object.values(store.tokens)) {
    let status: TokenListEntry["status"] = "active";
    if (meta.revokedAt !== undefined) {
      status = "revoked";
    } else if (meta.expiresAt !== undefined && now >= meta.expiresAt) {
      status = "expired";
    }
    entries.push({
      jti: meta.jti,
      subject: meta.subject,
      role: meta.role,
      scopes: meta.scopes,
      issuedAt: meta.issuedAt,
      expiresAt: meta.expiresAt,
      revokedAt: meta.revokedAt,
      lastUsedAt: meta.lastUsedAt,
      status,
    });
  }

  return entries.toSorted((a, b) => b.issuedAt - a.issuedAt);
}

export function tokenRevoke(params: { jti?: string; all?: boolean; stateDir?: string }): number {
  const stateDir = params.stateDir ?? resolveStateDir();
  let store = loadTokenStore(stateDir);
  const beforeCount = Object.values(store.tokens).filter((m) => m.revokedAt === undefined).length;

  if (params.all) {
    store = revokeAllTokens(store);
  } else if (params.jti) {
    if (!store.tokens[params.jti]) {
      throw new Error(`Token ${params.jti} not found in store.`);
    }
    store = revokeToken(store, params.jti);
  } else {
    throw new Error("Specify a token ID or --all.");
  }

  saveTokenStore(store, stateDir);
  const afterCount = Object.values(store.tokens).filter((m) => m.revokedAt === undefined).length;
  return beforeCount - afterCount;
}

export function tokenRotateKey(params?: {
  scopedTokenConfig?: ScopedTokenConfig;
  stateDir?: string;
}): void {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const cfg = params?.scopedTokenConfig;
  const keyPath = resolveSigningKeyPath(cfg, stateDir);

  const oldKeyPath = `${keyPath}.old`;
  if (fs.existsSync(keyPath)) {
    fs.renameSync(keyPath, oldKeyPath);
  }

  loadOrCreateSigningKey(keyPath);

  // Revoke all existing tokens since they won't validate with the new key
  let store = loadTokenStore(stateDir);
  store = revokeAllTokens(store);
  saveTokenStore(store, stateDir);
}

export function tokenInspect(tokenString: string): Record<string, unknown> | null {
  const payload = parseScopedToken(tokenString);
  if (!payload) {
    return null;
  }
  return {
    version: payload.v,
    tokenId: payload.jti,
    subject: payload.sub,
    role: payload.role,
    scopes: payload.scopes,
    methods: payload.methods,
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined,
    notBefore: payload.nbf ? new Date(payload.nbf * 1000).toISOString() : undefined,
  };
}

export function tokenPrune(params?: { stateDir?: string }): number {
  const stateDir = params?.stateDir ?? resolveStateDir();
  let store = loadTokenStore(stateDir);
  const beforeCount = Object.keys(store.tokens).length;
  store = pruneExpiredTokens(store);
  saveTokenStore(store, stateDir);
  return beforeCount - Object.keys(store.tokens).length;
}
