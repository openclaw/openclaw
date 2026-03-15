export type AgentAbortControllerEntry = {
  controller: AbortController;
  sessionKey?: string;
  startedAtMs: number;
  expiresAtMs: number;
};

export function resolveAgentRunExpiresAtMs(params: {
  now: number;
  timeoutMs?: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const {
    now,
    timeoutMs = 0,
    graceMs = 60_000,
    minMs = 2 * 60_000,
    maxMs = 24 * 60 * 60_000,
  } = params;
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const target = now + boundedTimeoutMs + graceMs;
  const min = now + minMs;
  const max = now + maxMs;
  return Math.min(max, Math.max(min, target));
}

export function abortAgentRunById(params: {
  agentAbortControllers: Map<string, AgentAbortControllerEntry>;
  runId: string;
  sessionKey?: string;
  reason?: unknown;
}): { aborted: boolean } {
  const active = params.agentAbortControllers.get(params.runId);
  if (!active) {
    return { aborted: false };
  }
  if (params.sessionKey && active.sessionKey && active.sessionKey !== params.sessionKey) {
    return { aborted: false };
  }
  active.controller.abort(params.reason);
  params.agentAbortControllers.delete(params.runId);
  return { aborted: true };
}
