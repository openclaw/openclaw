import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";

export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = raw.slice(7).trim();
  return token || undefined;
}

export function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    getHeader(req, "x-openclaw-agent-id")?.trim() ||
    getHeader(req, "x-openclaw-agent")?.trim() ||
    "";
  if (!raw) {
    return undefined;
  }
  return normalizeAgentId(raw);
}

export function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }

  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return normalizeAgentId(agentId);
}

export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) {
    return fromHeader;
  }

  const fromModel = resolveAgentIdFromModel(params.model);
  return fromModel ?? "main";
}

/**
 * Check whether a session key belongs to the given authenticated user.
 *
 * Session keys for identified users contain `-user:{login}` or `:user:{login}`.
 * When the auth layer provides a verified user identity (e.g. Tailscale whois),
 * this prevents one user from accessing another user's session by supplying an
 * arbitrary session key.
 */
export function sessionKeyBelongsToUser(sessionKey: string, authUser: string): boolean {
  const normalized = authUser.trim().toLowerCase();
  if (!normalized) {
    return true; // No user identity to validate against
  }
  const keyLower = sessionKey.toLowerCase();
  return keyLower.includes(`-user:${normalized}`) || keyLower.includes(`:user:${normalized}`);
}

export function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  prefix: string;
  /** Verified user identity from gateway auth (e.g. Tailscale login). */
  authUser?: string | undefined;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) {
    // When auth identifies a specific user, validate that the explicit session
    // key belongs to that user to prevent cross-session access (CWE-639).
    if (params.authUser && !sessionKeyBelongsToUser(explicit, params.authUser)) {
      // Ignore the explicit key and fall through to generate a user-bound key.
    } else {
      return explicit;
    }
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
