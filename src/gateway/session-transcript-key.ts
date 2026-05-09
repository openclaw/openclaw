import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  loadCombinedSessionEntriesForGateway,
  resolveGatewaySessionDatabaseTarget,
} from "./session-utils.js";

export function resolveSessionKeyForSessionScope(params: {
  agentId?: string;
  sessionId: string;
}): string | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  const cfg = getRuntimeConfig();
  const { entries: store } = loadCombinedSessionEntriesForGateway(cfg);
  const matches = Object.entries(store).filter(([key, entry]) => {
    if (entry?.sessionId !== sessionId) {
      return false;
    }
    const agentId = normalizeOptionalString(params.agentId);
    if (!agentId) {
      return true;
    }
    const target = resolveGatewaySessionDatabaseTarget({
      cfg,
      key,
    });
    return normalizeAgentId(target.agentId) === normalizeAgentId(agentId);
  });
  return resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) ?? matches[0]?.[0];
}
