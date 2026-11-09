import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";

export function sessionStateWatchAgentId(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKeyParts(sessionKey);
  return parsed && isValidAgentId(parsed.agentId) ? parsed.agentId.toLowerCase() : undefined;
}

export function isSessionStateWatchAddress(params: {
  watcherSessionKey: string;
  targetSessionKey: string;
  targetAgentId?: string;
}): boolean {
  const targetAgentId = sessionStateWatchAgentId(params.targetSessionKey);
  return Boolean(
    sessionStateWatchAgentId(params.watcherSessionKey) &&
    targetAgentId &&
    (params.targetAgentId === undefined ||
      (isValidAgentId(params.targetAgentId) &&
        params.targetAgentId.trim().toLowerCase() === targetAgentId)),
  );
}
