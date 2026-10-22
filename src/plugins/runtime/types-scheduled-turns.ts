/** Requester-bound schedules use the native scheduler; destinations and authority are host-owned. */
export type PluginCommandScheduleRequest = {
  /** Invocation-local idempotency key. Reusing it with different input is refused. */
  requestId: string;
  /** Canonical command name, without slash, owned by this same plugin. */
  command: string;
  args?: string;
  schedule: { kind: "at"; at: string } | { kind: "every"; everyMs: number };
  /** Absolute deadline, at most seven days from this invocation. */
  deadlineAtMs: number;
  /** Maximum admitted attempts, including interrupted attempts (1-100). */
  maxRuns: number;
};

export type PluginCommandScheduledTurns = {
  schedule: (request: PluginCommandScheduleRequest) => Promise<{
    jobId: string;
    deadlineAtMs: number;
    maxRuns: number;
  }>;
};
