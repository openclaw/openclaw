import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();
const runIdsBySessionKey = new Map<string, Set<string>>();

function normalizeSessionKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function addRunIdToSession(sessionKey: string, runId: string) {
  const existing = runIdsBySessionKey.get(sessionKey);
  if (!existing) {
    runIdsBySessionKey.set(sessionKey, new Set([runId]));
    return;
  }
  // Re-add to keep insertion order stable for latest-run lookup.
  if (existing.delete(runId)) {
    existing.add(runId);
    return;
  }
  existing.add(runId);
}

function removeRunIdFromSession(sessionKey: string, runId: string) {
  const existing = runIdsBySessionKey.get(sessionKey);
  if (!existing) {
    return;
  }
  existing.delete(runId);
  if (existing.size === 0) {
    runIdsBySessionKey.delete(sessionKey);
  }
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const nextSessionKey = normalizeSessionKey(context.sessionKey);
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    if (nextSessionKey) {
      addRunIdToSession(nextSessionKey, runId);
    }
    return;
  }
  const previousSessionKey = normalizeSessionKey(existing.sessionKey);
  if (nextSessionKey && existing.sessionKey !== nextSessionKey) {
    if (previousSessionKey) {
      removeRunIdFromSession(previousSessionKey, runId);
    }
    existing.sessionKey = nextSessionKey;
    addRunIdToSession(nextSessionKey, runId);
  } else if (nextSessionKey) {
    addRunIdToSession(nextSessionKey, runId);
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  const existing = runContextById.get(runId);
  if (existing?.sessionKey) {
    removeRunIdFromSession(existing.sessionKey, runId);
  }
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
  runIdsBySessionKey.clear();
}

export function getLatestAgentRunIdForSession(sessionKey: string): string | undefined {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return undefined;
  }
  const runIds = runIdsBySessionKey.get(normalized);
  if (!runIds || runIds.size === 0) {
    return undefined;
  }
  return Array.from(runIds).at(-1);
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
