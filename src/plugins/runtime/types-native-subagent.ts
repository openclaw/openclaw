/** Native children retain the current requester's authority and parent lineage. */
type NativeSubagentSpawnParams = {
  /** Stable within this parent turn and plugin; replay returns the native accepted child. */
  requestId: string;
  task: string;
  /** Local id registered by this plugin; cannot select another plugin’s profile. */
  profile?: string;
  taskName?: string;
  label?: string;
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto" | "ultrafast";
  context?: "fork" | "isolated";
  /** Hosts advertising `native-subagent-blind-v1`: the child's prompt omits its model and workspace. */
  blind?: boolean;
  runTimeoutSeconds?: number;
  outputSchema?: Record<string, unknown>;
};

/** Control facts recorded by the host; absent fields are unknown, not defaults. */
export type NativeSubagentSelection = {
  /** Explicit spawn inputs. Empty when the collecting invocation has no recorded request. */
  requested: { model?: string; thinking?: string; fastMode?: boolean | "auto" | "ultrafast" };
  /** Current child-session controls, not a claim that a provider honored them. */
  resolved?: { model?: string; thinking?: string; fastMode?: boolean | "auto" | "ultrafast" };
  /** Present only when the host has independent execution observations. */
  observed?: { model?: string; thinking?: string; fastMode?: boolean | "auto" | "ultrafast" };
};

export type NativeSubagentAccepted = {
  runId: string;
  childSessionKey: string;
  completionMode: "collect";
  selection?: NativeSubagentSelection;
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
    /** The result may be incomplete: its complete answer was unavailable or exceeded 100 KB. */
    resultTruncated?: true;
    structured?: unknown;
    error?: string;
    schemaError?: string;
    label?: string;
    usage?: { inputTokens: number; outputTokens: number };
    selection?: NativeSubagentSelection;
  }>;
  pending: string[];
  errors?: Array<{ runId: string; error: "not_found" | "not_owner" }>;
  success?: false;
};

export type NativeSubagentRuntime = {
  spawn(params: NativeSubagentSpawnParams): Promise<NativeSubagentAccepted>;
  collect(params: NativeSubagentCollectParams): Promise<NativeSubagentCollection>;
  /** Most recent 200 children owned by this plugin, requester and exact parent incarnation. */
  list?(
    this: void,
    params?: { status?: NativeSubagentChild["status"] },
  ): Promise<NativeSubagentChild[]>;
};

type NativeSubagentChild = {
  runId: string;
  childSessionKey: string;
  requestId: string;
  label?: string;
  /** Native completion when known; otherwise the recorded execution state. */
  status:
    | "queued"
    | "running"
    | "interrupted"
    | "terminal"
    | "done"
    | "failed"
    | "killed"
    | "timeout";
};
