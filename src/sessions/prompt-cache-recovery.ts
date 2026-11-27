import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isAcpSessionKey, isCronRunSessionKey, isSubagentSessionKey } from "./session-key-utils.js";

/** Machine-paced and internal sessions have no one coming back to a warm cache. */
export function isPromptCacheKeepWarmSessionKey(sessionKey: string): boolean {
  return !(
    isCronRunSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isInternalSessionEffectsKey(sessionKey)
  );
}

export function isPromptCacheRecoveryCandidate(
  sessionKey: string,
  entry: SessionEntry,
  since: number,
): boolean {
  // A successful ping preserves activity; a mid-series session can qualify by its ping alone.
  const touchedAt = Math.max(entry.lastActivityAt ?? 0, entry.promptCacheKeepWarm?.lastPingAt ?? 0);
  return !(touchedAt < since) && isPromptCacheKeepWarmSessionKey(sessionKey);
}
