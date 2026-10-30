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
    failed: number;
    /** Failed children not yet handed off require attention; failed remains the diagnostic total. */
    attentionFailed?: number;
    stopped?: number;
  };
};
