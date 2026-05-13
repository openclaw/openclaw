import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentRequestSessionKey,
} from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";

const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1_000;

type RunLookupCacheEntry = {
  sessionKey: string | null;
  expiresAt: number | null;
};

const resolvedSessionKeyByRunId = new Map<string, RunLookupCacheEntry>();

function runLookupCacheKey(runId: string, agentId: string): string {
  return `${agentId}\0${runId}`;
}

function setResolvedSessionKeyCache(
  runId: string,
  agentId: string,
  sessionKey: string | null,
): void {
  if (!runId) {
    return;
  }
  const cacheKey = runLookupCacheKey(runId, agentId);
  if (
    !resolvedSessionKeyByRunId.has(cacheKey) &&
    resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT
  ) {
    const oldest = resolvedSessionKeyByRunId.keys().next().value;
    if (oldest) {
      resolvedSessionKeyByRunId.delete(oldest);
    }
  }
  resolvedSessionKeyByRunId.set(cacheKey, {
    sessionKey,
    expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null,
  });
}

function sessionKeyMatchesAgent(sessionKey: string, agentId: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  return Boolean(parsed && parsed.agentId === agentId);
}

export function resolveSessionKeyForRun(runId: string, opts: { agentId?: string } = {}) {
  const cfg = getRuntimeConfig();
  const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
  const cacheKey = runLookupCacheKey(runId, agentId);
  const cachedLookup = resolvedSessionKeyByRunId.get(cacheKey);
  if (cachedLookup !== undefined) {
    if (cachedLookup.sessionKey !== null) {
      return cachedLookup.sessionKey;
    }
    if ((cachedLookup.expiresAt ?? 0) > Date.now()) {
      return undefined;
    }
    resolvedSessionKeyByRunId.delete(cacheKey);
  }
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached && sessionKeyMatchesAgent(cached, agentId)) {
    setResolvedSessionKeyCache(runId, agentId, cached);
    return cached;
  }
  const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId });
  const matches = Object.entries(store).filter(
    (entry): entry is [string, SessionEntry] => entry[1]?.sessionId === runId,
  );
  const storeKey = resolvePreferredSessionKeyForSessionIdMatches(matches, runId);
  if (storeKey) {
    const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
    registerAgentRunContext(runId, { sessionKey: storeKey });
    setResolvedSessionKeyCache(runId, agentId, sessionKey);
    return sessionKey;
  }
  setResolvedSessionKeyCache(runId, agentId, null);
  return undefined;
}

export function resetResolvedSessionKeyForRunCacheForTest(): void {
  resolvedSessionKeyByRunId.clear();
}
