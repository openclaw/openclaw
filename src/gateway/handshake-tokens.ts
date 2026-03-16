import { randomUUID } from "node:crypto";

export interface HandshakeToken {
  id: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  clientId?: string;
  endpoint: string;
}

export interface HandshakeTokenStore {
  tokens: Map<string, HandshakeToken>;
  usedNonces: Set<string>;
}

export function createHandshakeTokenStore(): HandshakeTokenStore {
  return {
    tokens: new Map(),
    usedNonces: new Set(),
  };
}

export function generateHandshakeToken(params: {
  clientId?: string;
  endpoint: string;
  ttlMs?: number;
}): HandshakeToken {
  const ttl = params.ttlMs ?? 30000;
  const now = Date.now();
  return {
    id: randomUUID(),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + ttl,
    clientId: params.clientId,
    endpoint: params.endpoint,
  };
}

export function storeHandshakeToken(store: HandshakeTokenStore, token: HandshakeToken): void {
  store.tokens.set(token.id, token);
  if (token.expiresAt < Date.now()) {
    store.tokens.delete(token.id);
  }
}

export function validateHandshakeToken(
  store: HandshakeTokenStore,
  tokenId: string,
  expectedNonce: string,
  options?: { checkClientId?: string },
): { ok: true } | { ok: false; reason: string } {
  const token = store.tokens.get(tokenId);

  if (!token) {
    return { ok: false, reason: "token not found or already used" };
  }

  if (Date.now() > token.expiresAt) {
    store.tokens.delete(tokenId);
    return { ok: false, reason: "token expired" };
  }

  if (token.nonce !== expectedNonce) {
    return { ok: false, reason: "invalid nonce" };
  }

  if (options?.checkClientId && token.clientId !== options.checkClientId) {
    return { ok: false, reason: "client ID mismatch" };
  }

  if (store.usedNonces.has(token.nonce)) {
    return { ok: false, reason: "nonce already used (replay attack detected)" };
  }

  store.usedNonces.add(token.nonce);
  store.tokens.delete(tokenId);

  return { ok: true };
}

export function cleanupExpiredTokens(store: HandshakeTokenStore): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, token] of store.tokens) {
    if (token.expiresAt < now) {
      store.tokens.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
