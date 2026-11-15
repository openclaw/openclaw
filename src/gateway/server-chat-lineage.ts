import { getRuntimeConfig } from "../config/io.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Enrich chat publications from the existing projection's current prepared lineage. */
export function resolveChatSessionSpawnedBy(
  sessionKey: string,
  getSessionRowProjection: (() => SessionRowProjection | undefined) | undefined,
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  const isDashboardSession = parsed?.rest.startsWith("dashboard:") === true;
  if (!isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey) && !isDashboardSession) {
    return null;
  }
  const agentId =
    parsed?.agentId ?? tryResolveSessionCompatibilityOwnerAgentId(getRuntimeConfig(), sessionKey);
  return agentId
    ? (getSessionRowProjection?.()?.readPreparedSpawnedBy({ key: sessionKey, agentId }) ?? null)
    : null;
}
