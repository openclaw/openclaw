import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PreparedLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.types.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isValidAgentId,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";

export type { PreparedLegacySessionSurfaces };

export function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

export function isLegacyDefaultMainAliasKey(key: string, mainKey: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(key.trim());
  const canonicalMainKey = normalizeMainKey(mainKey);
  return (
    lower === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` ||
    lower === `agent:${DEFAULT_AGENT_ID}:${canonicalMainKey}`
  );
}

export function resolveCanonicalAgentSessionOwner(key: string): string | undefined {
  const parsed = parseAgentSessionKey(key);
  if (
    parsed === null ||
    !isValidAgentId(parsed.agentId) ||
    normalizeAgentId(parsed.agentId) !== parsed.agentId
  ) {
    return undefined;
  }
  return parsed.agentId;
}
