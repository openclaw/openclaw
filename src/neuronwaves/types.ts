export type NeuronWavesConfig = {
  /** Enable NeuronWaves background runner. Disabled by default. */
  enabled: boolean;

  /** Minimum inactivity window before waves are allowed to run. */
  inactivityMs: number;

  /** Base interval between waves (before jitter). */
  baseIntervalMs: number;

  /** Additional randomized delay added to baseIntervalMs. */
  jitterMs: number;

  /** Maximum time budget for one wave tick. */
  maxWaveMs: number;

  /**
   * Whether to attempt to post GitHub PR comments (best-effort). If no auth is
   * available, this becomes a no-op.
   */
  postPrComments: boolean;

  /** PR to report status to (optional). */
  pr?: {
    repo: string; // e.g. "openclaw/openclaw"
    number: number;
  };
};

export type NeuronWaveDecision = {
  title: string;
  why: string;
  risk: "low" | "medium" | "high";
  action:
    | { kind: "noop"; reason: string }
    | { kind: "run"; command: string; cwd?: string }
    | { kind: "commit"; message: string };
};

export type NeuronWaveTraceEntry = {
  atMs: number;
  agentId: string;
  status: "skipped" | "ran" | "failed";
  reason?: string;
  inactivityMs?: number;
  nextRunAtMs?: number;
  notes?: string;
  decisions?: NeuronWaveDecision[];
  changes?: {
    git?: {
      branch?: string;
      commit?: string;
    };
  };
};
