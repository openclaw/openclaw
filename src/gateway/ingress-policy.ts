import { randomUUID } from "node:crypto";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

export type IngressAgentPolicyResolved = {
  defaultAgentId: string;
  knownAgentIds: Set<string>;
  allowedAgentIds?: Set<string>;
};

export type IngressSessionPolicyResolved = {
  defaultSessionKey?: string;
  allowRequestSessionKey: boolean;
  allowedSessionKeyPrefixes?: string[];
};

export type IngressDispatchPoliciesResolved = {
  agentPolicy: IngressAgentPolicyResolved;
  sessionPolicy: IngressSessionPolicyResolved;
};

export function resolveIngressDispatchPolicies(
  cfg: OpenClawConfig,
): IngressDispatchPoliciesResolved {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const knownAgentIds = new Set(listAgentIds(cfg));
  knownAgentIds.add(defaultAgentId);

  const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
  const defaultSessionKey = resolveSessionKey(cfg.hooks?.defaultSessionKey);
  const allowedSessionKeyPrefixes = resolveAllowedSessionKeyPrefixes(
    cfg.hooks?.allowedSessionKeyPrefixes,
  );

  if (
    defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix(defaultSessionKey, allowedSessionKeyPrefixes)
  ) {
    throw new Error("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");
  }
  if (
    !defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix("hook:example", allowedSessionKeyPrefixes)
  ) {
    throw new Error(
      "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    );
  }

  return {
    agentPolicy: {
      defaultAgentId,
      knownAgentIds,
      allowedAgentIds,
    },
    sessionPolicy: {
      defaultSessionKey,
      allowRequestSessionKey: cfg.hooks?.allowRequestSessionKey === true,
      allowedSessionKeyPrefixes,
    },
  };
}

export function resolveAllowedAgentIds(raw: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed = new Set<string>();
  let hasWildcard = false;
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      hasWildcard = true;
      break;
    }
    allowed.add(normalizeAgentId(trimmed));
  }
  if (hasWildcard) {
    return undefined;
  }
  return allowed;
}

function resolveSessionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function normalizeSessionKeyPrefix(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return value ? value : undefined;
}

function resolveAllowedSessionKeyPrefixes(raw: string[] | undefined): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const set = new Set<string>();
  for (const prefix of raw) {
    const normalized = normalizeSessionKeyPrefix(prefix);
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
  return set.size > 0 ? Array.from(set) : undefined;
}

function isSessionKeyAllowedByPrefix(sessionKey: string, prefixes: string[]): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function resolveIngressTargetAgentId(
  policies: IngressDispatchPoliciesResolved,
  agentId: string | undefined,
): string | undefined {
  const raw = agentId?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeAgentId(raw);
  if (policies.agentPolicy.knownAgentIds.has(normalized)) {
    return normalized;
  }
  return policies.agentPolicy.defaultAgentId;
}

export function isIngressAgentAllowed(
  policies: IngressDispatchPoliciesResolved,
  agentId: string | undefined,
): boolean {
  const raw = agentId?.trim();
  if (!raw) {
    return true;
  }
  const allowed = policies.agentPolicy.allowedAgentIds;
  if (allowed === undefined) {
    return true;
  }
  const resolved = resolveIngressTargetAgentId(policies, raw);
  return resolved ? allowed.has(resolved) : false;
}

export const getIngressAgentPolicyError = () => "agentId is not allowed by hooks.allowedAgentIds";
export const getIngressSessionKeyRequestPolicyError = () =>
  "sessionKey is disabled for external /hooks/agent payloads; set hooks.allowRequestSessionKey=true to enable";
export const getIngressSessionKeyPrefixError = (prefixes: string[]) =>
  `sessionKey must start with one of: ${prefixes.join(", ")}`;

export function resolveIngressSessionKey(params: {
  policies: IngressDispatchPoliciesResolved;
  source: "request" | "mapping";
  sessionKey?: string;
  idFactory?: () => string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const requested = resolveSessionKey(params.sessionKey);
  if (requested) {
    if (params.source === "request" && !params.policies.sessionPolicy.allowRequestSessionKey) {
      return { ok: false, error: getIngressSessionKeyRequestPolicyError() };
    }
    const allowedPrefixes = params.policies.sessionPolicy.allowedSessionKeyPrefixes;
    if (allowedPrefixes && !isSessionKeyAllowedByPrefix(requested, allowedPrefixes)) {
      return { ok: false, error: getIngressSessionKeyPrefixError(allowedPrefixes) };
    }
    return { ok: true, value: requested };
  }

  const defaultSessionKey = params.policies.sessionPolicy.defaultSessionKey;
  if (defaultSessionKey) {
    return { ok: true, value: defaultSessionKey };
  }

  const generated = `hook:${(params.idFactory ?? randomUUID)()}`;
  const allowedPrefixes = params.policies.sessionPolicy.allowedSessionKeyPrefixes;
  if (allowedPrefixes && !isSessionKeyAllowedByPrefix(generated, allowedPrefixes)) {
    return { ok: false, error: getIngressSessionKeyPrefixError(allowedPrefixes) };
  }
  return { ok: true, value: generated };
}

export function normalizeIngressDispatchSessionKey(params: {
  sessionKey: string;
  targetAgentId: string | undefined;
}): string {
  const trimmed = params.sessionKey.trim();
  if (!trimmed || !params.targetAgentId) {
    return trimmed;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (parsed.agentId !== targetAgentId) {
    return `agent:${parsed.agentId}:${parsed.rest}`;
  }
  return parsed.rest;
}
