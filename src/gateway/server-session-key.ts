import { AgentSelectionRequiredError, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { resolveChatRunOwnerAgentId } from "./chat-run-owner.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

// Stored keys must match their logical owner, including fixed-store sentinels.
function sessionKeyMatchesAgent(sessionKey: string, agentId: string, cfg: OpenClawConfig): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed && sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return false;
  }
  try {
    return (
      resolveSessionStoreIdentity({ cfg, sessionKey, agentId, preserveQualifiedAddress: true })
        .agentId === normalizedAgentId
    );
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return false;
    }
    throw error;
  }
}

/** Resolves the selected run owner and unchanged key without storage reads. */
export function resolveSessionForRun(
  runId: string,
  opts: { agentId?: string; projection?: Pick<SessionRowProjection, "findBySessionId"> } = {},
): Pick<SessionTranscriptRuntimeTarget, "sessionKey" | "agentId"> | undefined {
  const context = getAgentRunContext(runId);
  // Keyless admission is intentional for hidden internal work; never infer its parent.
  if (context && !context.sessionKey) {
    return undefined;
  }
  const explicitAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;
  const cached = context?.sessionKey;
  const cachedAgentId = resolveChatRunOwnerAgentId(context ?? {});
  if (cached) {
    if (!cachedAgentId) {
      return undefined;
    }
    if (!explicitAgentId) {
      return { sessionKey: cached, agentId: cachedAgentId };
    }
  }
  const cfg = getRuntimeConfig();
  const requestedAgentId = explicitAgentId ?? normalizeAgentId(resolveDefaultAgentId(cfg));
  if (
    cached &&
    (!context?.agentId?.trim() || cachedAgentId === requestedAgentId) &&
    sessionKeyMatchesAgent(cached, requestedAgentId, cfg)
  ) {
    return { sessionKey: cached, agentId: cachedAgentId ?? requestedAgentId };
  }
  // The projection owns both hits and absence. Committed identity publications
  // update its index, so orphan events need neither scans nor a timed miss cache.
  const matches: Array<{ key: string; entry: SessionEntry; agentId: string }> = [];
  for (const row of opts.projection?.findBySessionId({
    sessionId: runId,
    agentId: requestedAgentId,
    federated: true,
  }) ?? []) {
    const entry = row.sharingEntry ?? row.entry;
    if (
      entry?.sessionId === runId &&
      (!explicitAgentId || row.agentId === explicitAgentId) &&
      sessionKeyMatchesAgent(row.key, row.agentId, cfg)
    ) {
      matches.push({ key: row.key, entry, agentId: row.agentId });
    }
  }
  const storeKey = resolvePreferredSessionKeyForSessionIdMatches(
    matches.map(({ key, entry }) => [key, entry]),
    runId,
  );
  const selected = matches.find(({ key }) => key === storeKey);
  return selected ? { sessionKey: selected.key, agentId: selected.agentId } : undefined;
}
