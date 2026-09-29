// Session-store key canonicalization across default agents, main aliases, and legacy keys.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  isIncognitoSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";

/** Canonicalize an opaque session key into the agent-scoped store namespace. */
export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const lowered = normalizeLowercaseStringOrEmpty(key);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(key);
  return normalized.startsWith("agent:")
    ? normalized
    : `agent:${normalizeAgentId(agentId)}:${normalized}`;
}

// Logical unscoped keys must honor the durable fixed-store owner. The physical-store
// compatibility fallback is intentionally not used here because it can name a retired agent.
function resolveLogicalSessionStoreAgentId(cfg: OpenClawConfig, sessionKey: string): string {
  const agentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  if (agentId) {
    return agentId;
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
  if (persistedOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `session key "${sessionKey}"`,
      hint: `Its recorded owner "${persistedOwner.agentId}" is no longer configured. Select a configured agent explicitly.`,
    });
  }
  throw new AgentSelectionRequiredError(listAgentIds(cfg), {
    surface: `session key "${sessionKey}"`,
    hint: "Use an agent-prefixed session key or select an agent explicitly.",
  });
}

function resolveParsedSessionStoreKey(
  cfg: OpenClawConfig,
  raw: string,
  parsed: ParsedAgentSessionKey,
  options?: { storeAgentId?: string },
): { agentId: string; sessionKey: string } {
  const parsedAgentId = normalizeAgentId(parsed.agentId);
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  // Only legacy main aliases need the configured roster to resolve ownership.
  if (
    parsedAgentId !== DEFAULT_AGENT_ID ||
    (rest !== "main" && rest !== normalizeMainKey(cfg.session?.mainKey)) ||
    listAgentIds(cfg).includes(DEFAULT_AGENT_ID)
  ) {
    return {
      agentId: parsedAgentId,
      sessionKey: normalizeSessionKeyPreservingOpaquePeerIds(raw),
    };
  }
  const agentId = options?.storeAgentId
    ? normalizeAgentId(options.storeAgentId)
    : resolveLogicalSessionStoreAgentId(cfg, "main");
  return { agentId, sessionKey: `agent:${agentId}:${rest}` };
}

function canonicalizeParsedSessionStoreKey(
  cfg: OpenClawConfig,
  raw: string,
  parsed: ParsedAgentSessionKey,
  storeAgentId?: string,
  preserveQualifiedAddress = false,
): string {
  const resolved = resolveParsedSessionStoreKey(cfg, raw, parsed, { storeAgentId });
  if (preserveQualifiedAddress && resolved.agentId === normalizeAgentId(parsed.agentId)) {
    return resolved.sessionKey;
  }
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
  });
}

/** Resolve any incoming session key into the canonical key used in persisted session stores. */
export function resolveSessionStoreKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storeAgentId?: string;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    return canonicalizeParsedSessionStoreKey(params.cfg, raw, parsed, params.storeAgentId);
  }

  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const storeAgentId = params.storeAgentId ? normalizeAgentId(params.storeAgentId) : undefined;
  if (rawLower === "main" || rawLower === rawMainKey) {
    if (params.cfg.session?.scope === "global") {
      return "global";
    }
    return resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: storeAgentId ?? resolveLogicalSessionStoreAgentId(params.cfg, raw),
    });
  }
  const agentId = storeAgentId ?? resolveLogicalSessionStoreAgentId(params.cfg, raw);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

/** Resolve ownership before a prepared agent's main alias collapses to global. */
export function resolveSessionStoreAgentId(
  cfg: OpenClawConfig,
  canonicalKey: string,
  explicitAgentId?: string,
): string {
  if (explicitAgentId) {
    const parsed = parseAgentSessionKey(canonicalKey);
    const sessionKey = parsed
      ? resolveParsedSessionStoreKey(cfg, canonicalKey, parsed, {
          storeAgentId: explicitAgentId,
        }).sessionKey
      : canonicalKey;
    return resolveSessionAgentId({ config: cfg, sessionKey, agentId: explicitAgentId });
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  return parsed
    ? normalizeAgentId(parsed.agentId)
    : resolveLogicalSessionStoreAgentId(cfg, canonicalKey);
}

/** Preserve raw alias ownership and validate the canonical fixed-store boundary together. */
export function resolveSessionStoreIdentity(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): { agentId: string; canonicalKey: string } {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const parsed = parseAgentSessionKey(raw);
  const sessionKey = parsed
    ? resolveParsedSessionStoreKey(params.cfg, raw, parsed, { storeAgentId: requestedAgentId })
        .sessionKey
    : raw;
  const agentId = resolveSessionStoreAgentId(params.cfg, sessionKey, requestedAgentId);
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey,
    storeAgentId: agentId,
  });
  // Global removes the prefix, but may still belong to a different persisted fixed-store owner.
  resolveSessionStoreAgentId(params.cfg, canonicalKey, agentId);
  return { agentId, canonicalKey };
}

/** Resolve a session key for lookup inside a specific agent's store. */
export function resolveStoredSessionKeyForAgentStore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  preserveQualifiedAddress?: boolean;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return raw;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    return canonicalizeParsedSessionStoreKey(
      params.cfg,
      raw,
      parsed,
      params.agentId,
      params.preserveQualifiedAddress,
    );
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(params.cfg, raw);
  if (
    persistedOwner.kind === "configured" &&
    persistedOwner.agentId === normalizeAgentId(params.agentId) &&
    lowered !== "main" &&
    lowered !== normalizeMainKey(params.cfg.session?.mainKey)
  ) {
    return raw;
  }
  const key = canonicalizeSessionKeyForAgent(params.agentId, raw);
  return resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
    storeAgentId: params.agentId,
  });
}

/** Existing stored lineage wins; only absence permits the shipped main-alias lookup. */
export function selectStoredSessionLineage<T>(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  read: (agentId: string, sessionKey: string) => T | undefined;
  readAlias?: (agentId: string, sessionKey: string) => T | undefined;
}): { agentId: string; key: string; value: T | undefined } {
  const agentId = normalizeAgentId(
    parseAgentSessionKey(params.sessionKey)?.agentId ?? params.agentId,
  );
  const target = { cfg: params.cfg, agentId, sessionKey: params.sessionKey };
  const storedKey = resolveStoredSessionKeyForAgentStore({
    ...target,
    preserveQualifiedAddress: true,
  });
  const value = params.read(agentId, storedKey);
  if (value !== undefined || isIncognitoSessionKey(storedKey)) {
    return { agentId, key: storedKey, value };
  }
  const key = resolveStoredSessionKeyForAgentStore(target);
  return {
    agentId,
    key,
    value:
      key === storedKey && !params.readAlias
        ? undefined
        : (params.readAlias ?? params.read)(agentId, key),
  };
}

/** Resolve the owner agent for a stored session key, returning null for global/unknown keys. */
export function resolveStoredSessionOwnerAgentId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | null {
  const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return null;
  }
  return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}
