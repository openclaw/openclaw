import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../security/safe-regex.js";

/** Agent/session identity fields available when deciding whether to forward an approval request. */
export type ApprovalRequestFilterInput = {
  /** Explicit agent id carried by the approval payload, when the producer included one. */
  agentId?: string | null;
  /** Canonical or legacy session key used for session-scoped forwarding filters. */
  sessionKey?: string | null;
};

/**
 * Match a session key against literal substrings or safe bounded regex patterns.
 *
 * Literal substring checks run first for cheap common cases; regex patterns are compiled through
 * the safe-regex gate and tested with bounded input so forwarding rules cannot add regex DoS risk.
 */
export function matchesApprovalRequestSessionFilter(
  sessionKey: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => {
    if (sessionKey.includes(pattern)) {
      return true;
    }
    const regex = compileSafeRegex(pattern);
    return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
  });
}

/**
 * Apply approval forwarding filters to agent/session identity carried by the request.
 *
 * Agent filters require an explicit agent id unless the caller opts into parsing the canonical
 * session key, preserving legacy payload behavior for callers that do not trust session-derived ids.
 */
export function matchesApprovalRequestFilters(params: {
  request: ApprovalRequestFilterInput;
  agentFilter?: string[];
  sessionFilter?: string[];
  fallbackAgentIdFromSessionKey?: boolean;
}): boolean {
  if (params.agentFilter?.length) {
    const explicitAgentId = normalizeOptionalString(params.request.agentId);
    const sessionAgentId = params.fallbackAgentIdFromSessionKey
      ? (parseAgentSessionKey(params.request.sessionKey)?.agentId ?? undefined)
      : undefined;
    // Forwarded approvals may only carry a canonical session key, so callers opt into deriving
    // agent identity from that key when no explicit agent id is available.
    const agentId = explicitAgentId ?? sessionAgentId;
    if (!agentId || !params.agentFilter.includes(agentId)) {
      return false;
    }
  }

  if (params.sessionFilter?.length) {
    const sessionKey = normalizeOptionalString(params.request.sessionKey);
    if (!sessionKey || !matchesApprovalRequestSessionFilter(sessionKey, params.sessionFilter)) {
      return false;
    }
  }

  return true;
}
