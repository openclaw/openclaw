import crypto from "node:crypto";
import type { ChatType } from "../channels/chat-type.js";

export interface McpAttachGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** The openclaw session this grant is bound to; tool scope is resolved for this key. */
  readonly sessionKey: string;
  /** Trusted conversation kind bound when the grant is minted. */
  readonly chatType?: ChatType;
  /** Absolute expiry (ms epoch). */
  readonly expiresAtMs: number;
  /** Absolute mint time (ms epoch). */
  readonly issuedAtMs: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_TTL_MS = 12 * 60 * 60 * 1000;

const grantsByToken = new Map<string, McpAttachGrant>();

function clampTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(ttlMs as number, MAX_TTL_MS);
}

export function mintAttachGrant(params: {
  sessionKey: string;
  chatType?: ChatType;
  ttlMs?: number;
  nowMs?: number;
}): McpAttachGrant {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("mintAttachGrant: sessionKey is required");
  }
  const nowMs = params.nowMs ?? Date.now();
  // Mint sweeps stale entries so abandoned grants do not accumulate.
  sweepExpiredAttachGrants(nowMs);
  const grant: McpAttachGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    sessionKey,
    ...(params.chatType ? { chatType: params.chatType } : {}),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + clampTtlMs(params.ttlMs),
  };
  grantsByToken.set(grant.token, grant);
  return grant;
}

export function resolveAttachGrant(
  token: string,
  nowMs: number = Date.now(),
): McpAttachGrant | undefined {
  const grant = grantsByToken.get(token);
  if (!grant) {
    return undefined;
  }
  if (nowMs >= grant.expiresAtMs) {
    grantsByToken.delete(token);
    return undefined;
  }
  return grant;
}

export function revokeAttachGrant(token: string): boolean {
  return grantsByToken.delete(token);
}

export function revokeAttachGrantsForSession(sessionKey: string): number {
  const key = sessionKey.trim();
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (grant.sessionKey === key) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function sweepExpiredAttachGrants(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (nowMs >= grant.expiresAtMs) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function attachGrantStoreSize(): number {
  return grantsByToken.size;
}

export function resetAttachGrantsForTest(): void {
  grantsByToken.clear();
}
