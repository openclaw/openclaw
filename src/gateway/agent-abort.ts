export type AgentAbortControllerEntry = {
  controller: AbortController;
  sessionKey?: string;
  startedAtMs: number;
  expiresAtMs: number;
  clearableLanes?: string[];
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
  // Preserve no-timeout semantics: if the caller explicitly requested a timeout
  // longer than the default max (including timeout=0 → MAX_SAFE_TIMEOUT_MS),
  // skip the 24h cap to avoid force-aborting long-running workflows.
  if (boundedTimeoutMs > maxMs) {
    return now + boundedTimeoutMs + graceMs;
  }
  const target = now + boundedTimeoutMs + graceMs;
  const min = now + minMs;
  const max = now + maxMs;
  return Math.min(max, Math.max(min, target));
}

export function abortAgentRunById(
  params: {
    agentAbortControllers: Map<string, AgentAbortControllerEntry>;
    runId: string;
    sessionKey?: string;
    reason?: unknown;
  },
  laneCleaner?: {
    clearSessionLane: (sessionKey: string) => void;
    clearLane: (lane: string) => void;
  },
): { aborted: boolean } {
  const active = params.agentAbortControllers.get(params.runId);
  if (!active) {
    return { aborted: false };
  }
  if (active.sessionKey && params.sessionKey !== active.sessionKey) {
    return { aborted: false };
  }
  active.controller.abort(params.reason);
  params.agentAbortControllers.delete(params.runId);
  if (laneCleaner) {
    if (active.sessionKey) {
      laneCleaner.clearSessionLane(active.sessionKey);
    }
    if (active.clearableLanes) {
      for (const lane of active.clearableLanes) {
        laneCleaner.clearLane(lane);
      }
    }
  }
  return { aborted: true };
}
