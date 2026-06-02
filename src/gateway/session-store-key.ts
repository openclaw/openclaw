import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  canonicalizeMainSessionAlias,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";

/** Prefix a raw session key with the owning agent while preserving global/unknown sentinels. */
export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const lowered = normalizeLowercaseStringOrEmpty(key);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(key);
  if (normalized.startsWith("agent:")) {
    return normalized;
  }
  return `agent:${normalizeAgentId(agentId)}:${normalized}`;
}

function resolveDefaultStoreAgentId(cfg: OpenClawConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

function shouldRemapLegacyDefaultMainAlias(
  cfg: OpenClawConfig,
  parsed: ParsedAgentSessionKey,
  options?: { storeAgentId?: string },
): boolean {
  const agentId = normalizeAgentId(parsed.agentId);
  if (agentId !== DEFAULT_AGENT_ID || listAgentIds(cfg).includes(DEFAULT_AGENT_ID)) {
    return false;
  }
  const defaultAgentId = resolveDefaultStoreAgentId(cfg);
  if (options?.storeAgentId && normalizeAgentId(options.storeAgentId) !== defaultAgentId) {
    return false;
  }
  // Pre-agent stores used agent:main:main for the configured default session.
  // Only remap that legacy alias when the caller is reading the current default
  // agent store; deleted-agent and explicit-agent lookups must stay exact.
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  return rest === "main" || rest === mainKey;
}

function resolveParsedSessionStoreKey(
  cfg: OpenClawConfig,
  raw: string,
  parsed: ParsedAgentSessionKey,
  options?: { storeAgentId?: string },
): { agentId: string; sessionKey: string } {
  if (!shouldRemapLegacyDefaultMainAlias(cfg, parsed, options)) {
    return {
      agentId: normalizeAgentId(parsed.agentId),
      sessionKey: normalizeSessionKeyPreservingOpaquePeerIds(raw),
    };
  }
  const agentId = resolveDefaultStoreAgentId(cfg);
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  return { agentId, sessionKey: `agent:${agentId}:${rest}` };
}

/** Canonicalize a caller-provided session key to the key used by gateway session stores. */
export function resolveSessionStoreKey(params: {
  /** Config snapshot containing agent/default-session aliases. */
  cfg: OpenClawConfig;
  /** User, channel, or store-provided session key to canonicalize. */
  sessionKey: string;
  /** Agent store currently being read, used to avoid cross-agent legacy alias remaps. */
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
    const resolved = resolveParsedSessionStoreKey(params.cfg, raw, parsed, {
      storeAgentId: params.storeAgentId,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId: resolved.agentId,
      sessionKey: resolved.sessionKey,
    });
    if (canonical !== resolved.sessionKey) {
      return canonical;
    }
    return resolved.sessionKey;
  }

  const lowered = normalizeLowercaseStringOrEmpty(raw);
  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (lowered === "main" || lowered === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

/** Resolve the owning agent id from a canonical store key, falling back to the default agent. */
export function resolveSessionStoreAgentId(cfg: OpenClawConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveDefaultStoreAgentId(cfg);
}

/** Canonicalize a session key in the context of one physical agent store. */
export function resolveStoredSessionKeyForAgentStore(params: {
  /** Config snapshot containing agent/default-session aliases. */
  cfg: OpenClawConfig;
  /** Agent store whose keys are being read or written. */
  agentId: string;
  /** Raw key from the caller or store entry. */
  sessionKey: string;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return raw;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const key = parseAgentSessionKey(raw) ? raw : canonicalizeSessionKeyForAgent(params.agentId, raw);
  return resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
    storeAgentId: params.agentId,
  });
}

/** Resolve the agent that owns a stored session key, or null for global/unknown rows. */
export function resolveStoredSessionOwnerAgentId(params: {
  /** Config snapshot containing agent/default-session aliases. */
  cfg: OpenClawConfig;
  /** Agent store whose key is being inspected. */
  agentId: string;
  /** Raw key from the caller or store entry. */
  sessionKey: string;
}): string | null {
  const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return null;
  }
  return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}

/** Canonicalize a spawned-by reference relative to the spawning agent. */
export function canonicalizeSpawnedByForAgent(
  cfg: OpenClawConfig,
  agentId: string,
  spawnedBy?: string,
): string | undefined {
  const raw = normalizeOptionalString(spawnedBy) ?? "";
  if (!raw) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (lower === "global" || lower === "unknown") {
    return lower;
  }
  let result: string;
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (normalized.startsWith("agent:")) {
    result = normalized;
  } else {
    result = `agent:${normalizeAgentId(agentId)}:${normalized}`;
  }
  // Resolve main-alias references (e.g. agent:ops:main -> configured main key).
  const parsed = parseAgentSessionKey(result);
  const resolvedAgent = parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId;
  return canonicalizeMainSessionAlias({ cfg, agentId: resolvedAgent, sessionKey: result });
}
