import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";

export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "thinking"
  | "assistant"
  | "error"
  | (string & {});

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

type AgentEventListenerEntry = {
  listener: (evt: AgentEventPayload) => void;
  sessionKey?: string;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<AgentEventListenerEntry>;
  runContextById: Map<string, AgentRunContext>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

const state = resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
  seqByRun: new Map<string, number>(),
  listeners: new Set<AgentEventListenerEntry>(),
  runContextById: new Map<string, AgentRunContext>(),
}));

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
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
  return state.runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  state.runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  state.runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const resolvedSessionKey = eventSessionKey ?? context?.sessionKey;
  const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  notifyListeners(
    Array.from(state.listeners, (entry) => (payload: AgentEventPayload) => {
      if (entry.sessionKey && entry.sessionKey !== resolvedSessionKey) {
        return;
      }
      entry.listener(payload);
    }),
    enriched,
  );
}

export function onAgentEvent(
  listener: (evt: AgentEventPayload) => void,
  opts?: { sessionKey?: string },
) {
  const sessionKey = opts?.sessionKey?.trim() || undefined;
  const entry: AgentEventListenerEntry = { listener, sessionKey };
  state.listeners.add(entry);
  return () => state.listeners.delete(entry);
}

export function resetAgentEventsForTest() {
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
}
