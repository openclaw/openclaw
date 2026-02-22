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
  // RFC-A2A-RESPONSE-ROUTING: Response routing fields
  returnTo?: string; // Where to deliver the response
  correlationId?: string; // Matches request to response
  timeout?: number; // Timeout in ms
};

// Skill invocation payload structure for response routing
export type SkillInvocationPayload = {
  kind: "skill_invocation";
  skill: string;
  input: unknown;
  mode?: string;
  requester?: string;
  correlationId?: string;
  returnTo?: string;
  timeout?: number;
};

/**
 * Extract response routing fields from a skill_invocation message.
 * Returns null if the message is not a valid skill_invocation.
 */
export function extractSkillInvocationRouting(
  message: string,
): { returnTo: string; correlationId: string; timeout: number } | null {
  try {
    const parsed = JSON.parse(message) as SkillInvocationPayload;
    if (parsed.kind !== "skill_invocation") {
      return null;
    }
    if (!parsed.returnTo || !parsed.correlationId) {
      return null;
    }
    return {
      returnTo: parsed.returnTo,
      correlationId: parsed.correlationId,
      timeout: parsed.timeout ?? 60000,
    };
  } catch {
    return null;
  }
}

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();

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
  // RFC-A2A-RESPONSE-ROUTING: Update response routing fields
  if (context.returnTo !== undefined) {
    existing.returnTo = context.returnTo;
  }
  if (context.correlationId !== undefined) {
    existing.correlationId = context.correlationId;
  }
  if (context.timeout !== undefined) {
    existing.timeout = context.timeout;
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
