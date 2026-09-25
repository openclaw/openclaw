import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isValidAgentId,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

export type { PreparedLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.types.js";

export function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

export function isLegacyGroupKey(
  key: string,
  surfaces: readonly LegacySessionSurface[] = [],
): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of surfaces) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
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
