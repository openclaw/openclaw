/**
 * Per-session MCP loopback **attach grants**.
 *
 * The loopback MCP server (`mcp-http.ts`) authenticates the gateway-spawned cli-backend with two
 * process-global bearer tokens (owner / non-owner) and scopes tools from client-supplied headers —
 * adequate because that client is cooperative and gateway-launched. An **attach** grant is the
 * primitive for a *less-trusted* external/interactive harness (Claude Code, OpenCode, or a harness
 * reached via a node/companion app over its existing gateway connection): a short-lived, revocable
 * bearer whose **scope is bound to the grant**, not to the request headers.
 *
 * Security properties:
 * - The bound `sessionKey` comes from the grant, so an attach caller cannot scope-shop by setting
 *   `x-session-key` (the request layer ignores the header when a grant matches).
 * - Grants are always treated as **non-owner** (`senderIsOwner=false`) — the loopback surface
 *   already excludes the destructive native tools (`read/write/edit/apply_patch/exec/process`).
 * - TTL + explicit revoke bound the blast radius of a leaked token.
 *
 * Transport-independent: the same grant is presented whether the harness reaches the loopback over
 * 127.0.0.1 (gateway host) or tunnelled in over a node/app's existing authenticated channel.
 */
import crypto from "node:crypto";

export interface McpAttachGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** The openclaw session this grant is bound to; tool scope is resolved for this key. */
  readonly sessionKey: string;
  /** Absolute expiry (ms epoch). */
  readonly expiresAtMs: number;
  /** Absolute mint time (ms epoch). */
  readonly issuedAtMs: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_TTL_MS = 12 * 60 * 60 * 1000; // hard ceiling so a caller can't request a forever-grant

const grantsByToken = new Map<string, McpAttachGrant>();

function clampTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(ttlMs as number, MAX_TTL_MS);
}

/** Mint a grant bound to `sessionKey`. Returns the grant (the caller hands `token` to the harness). */
export function mintAttachGrant(params: {
  sessionKey: string;
  ttlMs?: number;
  nowMs?: number;
}): McpAttachGrant {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("mintAttachGrant: sessionKey is required");
  }
  const nowMs = params.nowMs ?? Date.now();
  // Sweep on mint so grants that are minted but never looked up again (harness never connects)
  // don't accumulate — lookup self-sweeps only the token it touches, so this bounds the map.
  sweepExpiredAttachGrants(nowMs);
  const grant: McpAttachGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    sessionKey,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + clampTtlMs(params.ttlMs),
  };
  grantsByToken.set(grant.token, grant);
  return grant;
}

/**
 * Resolve a bearer token to a live grant, or `undefined` if unknown/expired. An expired grant is
 * dropped on lookup (lazy sweep). Lookup is by full-token map key: a caller must already hold the
 * complete 256-bit token to get a hit, so there is no partial-match timing oracle to defend.
 */
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

/** Revoke a grant by token. Returns true if a grant was removed. */
export function revokeAttachGrant(token: string): boolean {
  return grantsByToken.delete(token);
}

/** Revoke every live grant for a session (e.g. on session teardown). Returns the count removed. */
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

/** Drop expired grants. Returns the count swept. Call opportunistically; lookup also self-sweeps. */
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

/** Number of entries currently held (test/diagnostics). Does not sweep; reflects raw store size. */
export function attachGrantStoreSize(): number {
  return grantsByToken.size;
}

/** Clear all grants (test isolation only). */
export function resetAttachGrantsForTest(): void {
  grantsByToken.clear();
}
