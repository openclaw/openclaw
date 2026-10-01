import { AgentSelectionRequiredError, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentRequestSessionKey,
} from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

// Keep global run matching scoped and reject malformed qualified keys before
// normalizing aliases; the prepared owner must survive a main alias becoming global.
function sessionKeyMatchesAgent(sessionKey: string, agentId: string, cfg: OpenClawConfig): boolean {
  if (cfg.session?.scope === "global" && sessionKey.trim().toLowerCase() === "global") {
    return true;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed && sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return false;
  }
  try {
    return resolveSessionStoreIdentity({ cfg, sessionKey, agentId }).agentId === normalizedAgentId;
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return false;
    }
    throw error;
  }
}

function resolveRunSessionKeyForCaller(storeKey: string) {
  return toAgentRequestSessionKey(storeKey) ?? storeKey;
}

/** Resolves live runs or the resident current-session ID index without storage reads. */
export function resolveSessionKeyForRun(
  runId: string,
  opts: { agentId?: string; projection?: Pick<SessionRowProjection, "findBySessionId"> } = {},
) {
  const context = getAgentRunContext(runId);
  // Keyless admission is intentional for hidden internal work; never infer its parent.
  if (context && !context.sessionKey) {
    return undefined;
  }
  const explicitAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const cached = context?.sessionKey;
  if (!explicitAgentId && cached) {
    return cached;
  }
  const cfg = getRuntimeConfig();
  const requestedAgentId = explicitAgentId ?? normalizeAgentId(resolveDefaultAgentId(cfg));
  if (cached && sessionKeyMatchesAgent(cached, requestedAgentId, cfg)) {
    return resolveRunSessionKeyForCaller(cached);
  }
  // The projection owns both hits and absence. Committed identity publications
  // update its index, so orphan events need neither scans nor a timed miss cache.
  const matches: Array<[string, SessionEntry]> = [];
  for (const row of opts.projection?.findBySessionId({
    sessionId: runId,
    agentId: requestedAgentId,
    federated: true,
  }) ?? []) {
    const entry = row.sharingEntry ?? row.entry;
    if (entry?.sessionId === runId && sessionKeyMatchesAgent(row.key, requestedAgentId, cfg)) {
      matches.push([row.key, entry]);
    }
  }
  const storeKey = resolvePreferredSessionKeyForSessionIdMatches(matches, runId);
  return storeKey ? resolveRunSessionKeyForCaller(storeKey) : undefined;
}
