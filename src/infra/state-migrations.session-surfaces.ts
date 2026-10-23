import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import type { SessionScope } from "../config/sessions/types.js";
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

export function isAmbiguousSharedStoreKey(
  key: string,
  mainKey: string,
  scope?: SessionScope,
): boolean {
  const raw = key.trim();
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!raw || lower === "global" || lower === "unknown") {
    return false;
  }
  if (
    scope === "global" &&
    canonicalizeMainSessionAlias({
      cfg: { session: { scope, mainKey } },
      agentId: DEFAULT_AGENT_ID,
      sessionKey: lower,
    }) === "global"
  ) {
    return false;
  }
  return !resolveCanonicalAgentSessionOwner(raw) || isLegacyDefaultMainAliasKey(lower, mainKey);
}

export function isLegacyDefaultMainAliasKey(key: string, mainKey: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(key);
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
