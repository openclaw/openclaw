/** Native children retain the current reply request's authority and parent lineage. */
type NativeSubagentSpawnParams = {
  /** Stable within this parent turn and plugin; replay returns the native accepted child. */
  requestId: string;
  task: string;
  taskName?: string;
  label?: string;
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto" | "ultrafast";
  context?: "fork" | "isolated";
  runTimeoutSeconds?: number;
  outputSchema?: Record<string, unknown>;
};

export type NativeSubagentAccepted = {
  runId: string;
  childSessionKey: string;
  completionMode: "collect";
};

type NativeSubagentCollectParams = {
  ids: string[];
  /** Zero reads current status. Omit to use the native bounded wait. */
  timeoutSeconds?: number;
  /** Join all results without polling; mutually exclusive with timeoutSeconds. */
  awaitResults?: boolean;
};

type NativeSubagentCollection = {
  completed: Array<{
    runId: string;
    sessionKey: string;
    status: "done" | "failed" | "killed" | "timeout";
    result: string;
    structured?: unknown;
    error?: string;
    schemaError?: string;
    label?: string;
    usage?: { inputTokens: number; outputTokens: number };
  }>;
  pending: string[];
  errors?: Array<{ runId: string; error: "not_found" | "not_owner" }>;
  success?: false;
};

export type NativeSubagentRuntime = {
  spawn(params: NativeSubagentSpawnParams): Promise<NativeSubagentAccepted>;
  collect(params: NativeSubagentCollectParams): Promise<NativeSubagentCollection>;
};
