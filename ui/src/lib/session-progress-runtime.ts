/** Live session facts, separate from the agent-authored durable plan. */
export type SessionProgressCardRuntime = {
  known?: boolean;
  connected?: boolean;
  hasActiveSubagentRun?: boolean;
  lastRunError?: string;
  childError?: string;
  /** Exact counts only after the session's own child roster has loaded. */
  children?: {
    running: number;
    queued: number;
    waiting: number;
    /** Yielded on sessions_yield: unfinished, but not active work. */
    paused?: number;
    failed: number;
    stopped?: number;
  };
};
