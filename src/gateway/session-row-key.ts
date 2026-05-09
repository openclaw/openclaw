import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const lowered = normalizeLowercaseStringOrEmpty(key);
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}

function resolveDefaultSessionAgentId(cfg: OpenClawConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

function resolveParsedSessionRowKey(
  raw: string,
  parsed: ParsedAgentSessionKey,
): { agentId: string; sessionKey: string } {
  return {
    agentId: normalizeAgentId(parsed.agentId),
    sessionKey: normalizeLowercaseStringOrEmpty(raw),
  };
}

export function resolveSessionRowKey(params: { cfg: OpenClawConfig; sessionKey: string }): string {
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
    const resolved = resolveParsedSessionRowKey(raw, parsed);
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
  const agentId = resolveDefaultSessionAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, lowered);
}

export function resolveSessionRowAgentId(cfg: OpenClawConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultSessionAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveDefaultSessionAgentId(cfg);
}

export function resolveStoredSessionRowKeyForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
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
  const storageAgentId = normalizeAgentId(params.agentId);
  if (storageAgentId === resolveDefaultSessionAgentId(params.cfg)) {
    const storageAgentCanonicalKey = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId: storageAgentId,
      sessionKey: lowered,
    });
    if (storageAgentCanonicalKey !== lowered) {
      return storageAgentCanonicalKey;
    }
  }
  const key = parseAgentSessionKey(raw) ? raw : canonicalizeSessionKeyForAgent(params.agentId, raw);
  return resolveSessionRowKey({
    cfg: params.cfg,
    sessionKey: key,
  });
}

export function resolveStoredSessionOwnerAgentId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | null {
  const storageAgentId = normalizeAgentId(params.agentId);
  const rawKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
  const storageAgentMainKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: storageAgentId,
  });
  const storageAgentCanonicalKey =
    storageAgentId === resolveDefaultSessionAgentId(params.cfg)
      ? canonicalizeMainSessionAlias({
          cfg: params.cfg,
          agentId: storageAgentId,
          sessionKey: rawKey,
        })
      : rawKey;
  if (storageAgentCanonicalKey === storageAgentMainKey && rawKey !== storageAgentCanonicalKey) {
    return storageAgentId;
  }
  const canonicalKey = resolveStoredSessionRowKeyForAgent(params);
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return null;
  }
  return resolveSessionRowAgentId(params.cfg, canonicalKey);
}

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
  if (lower.startsWith("agent:")) {
    result = lower;
  } else {
    result = `agent:${normalizeAgentId(agentId)}:${lower}`;
  }
  // Resolve main-alias references (e.g. agent:ops:main -> configured main key).
  const parsed = parseAgentSessionKey(result);
  const resolvedAgent = parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId;
  return canonicalizeMainSessionAlias({ cfg, agentId: resolvedAgent, sessionKey: result });
}
