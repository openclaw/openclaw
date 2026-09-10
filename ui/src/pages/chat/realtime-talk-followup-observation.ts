/** Result of an `agent.wait` Gateway request. */
export interface AgentWaitResult {
  status?: string;
  error?: string;
  stopReason?: string;
  endedAt?: number;
  pendingError?: boolean;
  timeoutPhase?: string;
  providerStarted?: boolean;
  aborted?: boolean;
  livenessState?: string;
  yielded?: boolean;
  /** RunId of the follow-up turn admitted from this queue, for secure client-side correlation. */
  followupRunId?: string;
}

const FOLLOWUP_POLL_INTERVAL_MS = 2000;

/**
 * When `agent.wait` returns `pending` without a `followupRunId`, the gateway
 * has not yet admitted the follow-up run. The follow-up runId is allocated
 * after `admitFollowupTurn` runs, which happens asynchronously once the queue
 * drain reaches the group. This observer polls `agent.wait` on a bounded
 * retry loop to capture the follow-up runId when admission completes, so the
 * client can switch from accepting any runId to matching the exact follow-up
 * runId for secure result correlation.
 */
export function observePendingFollowupRunId(params: {
  client: {
    request: (method: string, input: unknown) => Promise<AgentWaitResult>;
  };
  runId: string;
  timeoutMs: number;
  isSettled: () => boolean;
  isFollowupObserved: () => boolean;
  onFollowupObserved: (followupRunId: string) => void;
  onError: (error: Error) => void;
}): () => void {
  let startTime = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const isDeadlineReached = () => {
    return Date.now() - startTime >= params.timeoutMs;
  };

  const poll = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (params.isSettled() || params.isFollowupObserved()) {
      return;
    }
    if (isDeadlineReached()) {
      return;
    }
    void params.client
      .request("agent.wait", {
        runId: params.runId,
        timeoutMs: FOLLOWUP_POLL_INTERVAL_MS,
      })
      .then((result) => {
        if (params.isSettled() || params.isFollowupObserved()) {
          return;
        }
        if (isDeadlineReached()) {
          return;
        }
        const status = result?.status;
        // A terminal state here is unexpected during follow-up observation;
        // surface it rather than silently dropping the turn.
        if (status === "error" && result && typeof result === "object" && "error" in result) {
          return;
        }
        if (status === "pending" && result?.followupRunId) {
          params.onFollowupObserved(result.followupRunId);
          return;
        }
        // Schedule the next poll using the remaining consultation deadline.
        const remaining = params.timeoutMs - (Date.now() - startTime);
        timeoutId = setTimeout(poll, Math.min(FOLLOWUP_POLL_INTERVAL_MS, remaining));
      })
      .catch(() => {
        if (params.isFollowupObserved()) {
          return;
        }
        if (isDeadlineReached()) {
          return;
        }
        const remaining = params.timeoutMs - (Date.now() - startTime);
        timeoutId = setTimeout(poll, Math.min(FOLLOWUP_POLL_INTERVAL_MS, remaining));
      });
  };

  // Delay the first poll so a same-frame follow-upRunId in the pending
  // response is captured synchronously before polling begins.
  startTime = Date.now();
  timeoutId = setTimeout(poll, FOLLOWUP_POLL_INTERVAL_MS);
  return () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  };
}
