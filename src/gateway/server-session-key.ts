import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { loadCombinedSessionEntriesForGateway } from "./session-utils.js";

const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1_000;

export type RunSessionKeySelection =
  | { kind: "none" }
  | {
      kind: "selected";
      storeSessionKey: string;
      requestSessionKey: string;
    }
  | {
      kind: "ambiguous";
      storeSessionKeys: string[];
      requestSessionKeys: string[];
    };

type RunLookupCacheEntry = {
  selection: RunSessionKeySelection;
  expiresAt: number | null;
};

const resolvedSessionKeyByRunId = new Map<string, RunLookupCacheEntry>();

function normalizeRequestSessionKey(sessionKey: string): string {
  return toAgentRequestSessionKey(sessionKey) ?? sessionKey;
}

function normalizeRequestSessionKeys(sessionKeys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const sessionKey of sessionKeys) {
    const requestSessionKey = normalizeRequestSessionKey(sessionKey);
    if (seen.has(requestSessionKey)) {
      continue;
    }
    seen.add(requestSessionKey);
    normalized.push(requestSessionKey);
  }
  return normalized;
}

function setResolvedSessionKeyCache(runId: string, selection: RunSessionKeySelection): void {
  if (!runId) {
    return;
  }
  if (
    !resolvedSessionKeyByRunId.has(runId) &&
    resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT
  ) {
    const oldest = resolvedSessionKeyByRunId.keys().next().value;
    if (oldest) {
      resolvedSessionKeyByRunId.delete(oldest);
    }
  }
  resolvedSessionKeyByRunId.set(runId, {
    selection,
    expiresAt: selection.kind === "selected" ? null : Date.now() + RUN_LOOKUP_MISS_TTL_MS,
  });
}

function resolveRunSelectionFromStore(runId: string): RunSessionKeySelection {
  const cachedLookup = resolvedSessionKeyByRunId.get(runId);
  if (cachedLookup !== undefined) {
    if (cachedLookup.selection.kind === "selected") {
      return cachedLookup.selection;
    }
    if ((cachedLookup.expiresAt ?? 0) > Date.now()) {
      return cachedLookup.selection;
    }
    resolvedSessionKeyByRunId.delete(runId);
  }
  const cfg = getRuntimeConfig();
  const { entries: store } = loadCombinedSessionEntriesForGateway(cfg);
  const matches = Object.entries(store).filter(
    (entry): entry is [string, SessionEntry] => entry[1]?.sessionId === runId,
  );
  const selection = resolveSessionIdMatchSelection(matches, runId);
  switch (selection.kind) {
    case "selected": {
      const resolvedSelection: RunSessionKeySelection = {
        kind: "selected",
        storeSessionKey: selection.sessionKey,
        requestSessionKey: normalizeRequestSessionKey(selection.sessionKey),
      };
      setResolvedSessionKeyCache(runId, resolvedSelection);
      return resolvedSelection;
    }
    case "ambiguous": {
      const resolvedSelection: RunSessionKeySelection = {
        kind: "ambiguous",
        storeSessionKeys: selection.sessionKeys,
        requestSessionKeys: normalizeRequestSessionKeys(selection.sessionKeys),
      };
      setResolvedSessionKeyCache(runId, resolvedSelection);
      return resolvedSelection;
    }
    case "none":
    default:
      setResolvedSessionKeyCache(runId, { kind: "none" });
      return { kind: "none" };
  }
}

export function resolveSessionKeySelectionForRun(runId: string): RunSessionKeySelection {
  return resolveRunSelectionFromStore(runId);
}

export function resolveSessionKeyForRun(runId: string) {
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached) {
    return cached;
  }
  const selection = resolveRunSelectionFromStore(runId);
  if (selection.kind === "selected") {
    registerAgentRunContext(runId, { sessionKey: selection.requestSessionKey });
    return selection.requestSessionKey;
  }
  return undefined;
}

export function resetResolvedSessionKeyForRunCacheForTest(): void {
  resolvedSessionKeyByRunId.clear();
}
