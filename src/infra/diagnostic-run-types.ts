export type DiagnosticRunScopeFields = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  trigger?: string;
  channel?: string;
};

/** Bounded interruption facts recorded by the attempt owner, never inferred from error text. */
export type DiagnosticRunInterruption = {
  abortCause:
    | "user_abort"
    | "restart"
    | "superseded"
    | "external_signal"
    | "runtime_abort"
    | "yield_cleanup"
    | "timeout";
  timeoutPhase?: "prompt" | "compaction" | "tool_execution";
  timeoutSource?: "runtime" | "run_budget" | "idle" | "external";
};

/** Filters terminal diagnostic fields before retention or export, including JavaScript emitters. */
export function normalizeDiagnosticRunInterruption(input: {
  abortCause?: unknown;
  timeoutPhase?: unknown;
  timeoutSource?: unknown;
}): Partial<DiagnosticRunInterruption> {
  const interruption: Partial<DiagnosticRunInterruption> = {};
  switch (input.abortCause) {
    case "user_abort":
    case "restart":
    case "superseded":
    case "external_signal":
    case "runtime_abort":
    case "yield_cleanup":
    case "timeout":
      interruption.abortCause = input.abortCause;
  }
  switch (input.timeoutPhase) {
    case "prompt":
    case "compaction":
    case "tool_execution":
      interruption.timeoutPhase = input.timeoutPhase;
  }
  switch (input.timeoutSource) {
    case "runtime":
    case "run_budget":
    case "idle":
    case "external":
      interruption.timeoutSource = input.timeoutSource;
  }
  return interruption;
}

export type DiagnosticRunCompletedFields = Partial<DiagnosticRunInterruption> & {
  type: "run.completed";
  durationMs: number;
  outcome: "completed" | "aborted" | "blocked" | "error";
  errorCategory?: string;
  blockedBy?: string;
};

export type DiagnosticAgentCommentaryFields = DiagnosticRunScopeFields & {
  type: "agent.commentary";
  harnessId: string;
  pluginId?: string;
  itemId?: string;
  sourceSequence: number;
  sourceTimestampMs: number;
  textLength: number;
  contentCaptured: boolean;
  contentTruncated: boolean;
};
