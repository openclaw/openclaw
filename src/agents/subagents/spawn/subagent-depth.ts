/**
 * Subagent spawn-depth lookup helpers.
 *
 * Reads persisted session store state to recover spawn depth and parent lineage across restarts.
 */
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import {
  findSubagentSessionEntryById,
  getSubagentDepthFromEntryLookup,
  type SessionDepthEntry,
} from "./subagent-depth-policy.js";

export function readSubagentSessionStore(
  storePath: string,
  agentId: string,
): Record<string, SessionEntry> {
  try {
    return Object.fromEntries(
      listSessionEntriesReadOnly({ agentId, storePath, clone: false, projection: "list" }).map(
        ({ sessionKey, entry }) => [sessionKey, entry],
      ),
    );
  } catch {
    // ignore missing/unavailable stores
  }
  return {};
}

function buildKeyCandidates(
  rawKey: string,
  cfg?: OpenClawConfig,
  explicitAgentId?: string,
): string[] {
  if (!cfg) {
    return [rawKey];
  }
  if (rawKey === "unknown") {
    return [rawKey];
  }
  if (parseAgentSessionKey(rawKey)) {
    return [rawKey];
  }
  const agentId = resolveSessionAgentId({
    sessionKey: rawKey,
    config: cfg,
    agentId: explicitAgentId,
  });
  const prefixed = `agent:${agentId}:${rawKey}`;
  return prefixed === rawKey ? [rawKey] : [rawKey, prefixed];
}

function resolveEntryForSessionKey(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: Record<string, SessionDepthEntry>;
  cache: Map<string, Record<string, SessionEntry>>;
  agentId?: string;
}): SessionDepthEntry | undefined {
  const candidates = buildKeyCandidates(params.sessionKey, params.cfg, params.agentId);

  if (params.store) {
    for (const key of candidates) {
      const entry = params.store[key];
      if (entry) {
        return entry;
      }
    }
    const entry = findSubagentSessionEntryById(params.store, params.sessionKey);
    if (entry || !params.cfg) {
      return entry;
    }
  }

  if (!params.cfg) {
    return undefined;
  }

  const candidateAgentIds = new Set(
    candidates.flatMap((key) => {
      const agentId = parseAgentSessionKey(key)?.agentId;
      return agentId ? [agentId] : [];
    }),
  );
  for (const agentId of candidateAgentIds) {
    const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    // A fixed path still exposes an agent-scoped logical view. Reusing another
    // agent's snapshot can erase cross-agent lineage or adopt the wrong row.
    const cacheKey = `${storePath}\0${normalizeAgentId(agentId)}`;
    let store = params.cache.get(cacheKey);
    if (!store) {
      store = readSubagentSessionStore(storePath, agentId);
      params.cache.set(cacheKey, store);
    }
    const entry =
      candidates.map((key) => store[key]).find((candidate) => candidate !== undefined) ??
      findSubagentSessionEntryById(store, params.sessionKey);
    if (entry) {
      return entry;
    }
  }

  return undefined;
}

export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionDepthEntry>;
    agentId?: string;
  },
): number {
  const cache = new Map<string, Record<string, SessionEntry>>();
  return getSubagentDepthFromEntryLookup(sessionKey, (key) =>
    resolveEntryForSessionKey({
      sessionKey: key,
      cfg: opts?.cfg,
      store: opts?.store,
      cache,
      agentId: opts?.agentId,
    }),
  );
}
