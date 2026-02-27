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

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext & { lastActiveAt: number }>();

/** Maximum age (ms) before an idle run context is pruned. */
const RUN_CONTEXT_TTL_MS = 30 * 60_000; // 30 minutes
/** How often the TTL sweep runs. */
const RUN_CONTEXT_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
let runContextSweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureRunContextSweep() {
  if (runContextSweepTimer) {
    return;
  }
  runContextSweepTimer = setInterval(() => {
    const cutoff = Date.now() - RUN_CONTEXT_TTL_MS;
    for (const [runId, ctx] of runContextById) {
      if (ctx.lastActiveAt < cutoff) {
        runContextById.delete(runId);
        seqByRun.delete(runId);
      }
    }
    if (runContextById.size === 0) {
      clearInterval(runContextSweepTimer!);
      runContextSweepTimer = null;
    }
  }, RUN_CONTEXT_SWEEP_INTERVAL_MS);
  runContextSweepTimer.unref?.();
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context, lastActiveAt: Date.now() });
    ensureRunContextSweep();
    return;
  }
  existing.lastActiveAt = Date.now();
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
  const ctx = runContextById.get(runId);
  if (ctx) {
    ctx.lastActiveAt = Date.now();
  }
  return ctx;
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
  seqByRun.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
  seqByRun.clear();
  if (runContextSweepTimer) {
    clearInterval(runContextSweepTimer);
    runContextSweepTimer = null;
  }
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
