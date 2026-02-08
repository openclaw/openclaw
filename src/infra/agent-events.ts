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
};

// Use global singleton registry to avoid dual-package hazard
// When tsdown bundles multiple entry points, agent-events code gets duplicated
// Using globalThis ensures both bundled core and jiti-loaded plugins share the same registry
declare global {
  var __openclawAgentSeqByRun: Map<string, number> | undefined;
  var __openclawAgentListeners: Set<(evt: AgentEventPayload) => void> | undefined;
  var __openclawAgentRunContext: Map<string, AgentRunContext> | undefined;
}

if (!globalThis.__openclawAgentSeqByRun) {
  globalThis.__openclawAgentSeqByRun = new Map<string, number>();
}
if (!globalThis.__openclawAgentListeners) {
  globalThis.__openclawAgentListeners = new Set<(evt: AgentEventPayload) => void>();
}
if (!globalThis.__openclawAgentRunContext) {
  globalThis.__openclawAgentRunContext = new Map<string, AgentRunContext>();
}

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = globalThis.__openclawAgentSeqByRun;
const listeners = globalThis.__openclawAgentListeners;
const runContextById = globalThis.__openclawAgentRunContext;

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
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
