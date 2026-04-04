/**
 * Meta-Harness type definitions
 *
 * Runtime types for flow traces, child traces, rich traces,
 * and daily/weekly summaries as specified by the quantum-rules contract.
 */

/** Unique trace identifier (UUID v4) */
export type TraceId = string;

/** Trigger type for a top-level run */
export type TriggerKind = "session" | "heartbeat" | "cron";

/** Automation level per quantum-self/automation-governance.md */
export type AutomationLevel = "A" | "B" | "C" | "D" | "X";

/** Triage domain per quantum-self/capability-map.md */
export type TriageDomain =
  | "strategy"
  | "research"
  | "build"
  | "delivery"
  | "growth"
  | "ops"
  | "governance"
  | "unknown";

/** Run outcome */
export type RunOutcome = "completed" | "partial" | "failed" | "escalated" | "aborted";

/** Flow trace — one per top-level session/heartbeat/cron run */
export type FlowTrace = {
  trace_id: TraceId;
  timestamp: string; // ISO 8601
  session_id: string;
  flow_id: string;
  trigger: TriggerKind;
  task_summary: string;
  triage_domain: TriageDomain;
  automation_level: AutomationLevel;
  delegation_list: DelegationEntry[];
  outcome: RunOutcome;
  observations: Observation[];
  harness_version: string;
  /** Tool call outcomes from this run */
  tool_outcomes: ToolOutcome[];
  /** Total duration in ms */
  duration_ms: number;
};

/** Child trace — one per delegated agent task */
export type ChildTrace = {
  child_trace_id: TraceId;
  parent_trace_id: TraceId;
  child_session_id: string;
  agent_type: string;
  task_brief: string;
  status: RunOutcome;
  verification_summary: string;
  failure_or_escalation_reason?: string;
  summarized_tool_calls: ToolOutcome[];
  timestamp: string; // ISO 8601
  duration_ms?: number;
};

/** Rich trace — full raw transcript, only written on escalation */
export type RichTrace = {
  trace_id: TraceId;
  parent_trace_id?: TraceId;
  escalation_reason: string;
  timestamp: string;
  raw_content: string; // JSON-serialized raw trace data
};

/** Delegation entry in a flow trace */
export type DelegationEntry = {
  child_trace_id: TraceId;
  agent_type: string;
  task_brief: string;
  status: RunOutcome;
};

/** Observation with evidence grading */
export type Observation = {
  kind: "OBSERVED" | "INFERRED" | "NOT_VERIFIED";
  summary: string;
};

/** Tool call outcome */
export type ToolOutcome = {
  tool_name: string;
  success: boolean;
  error?: string;
  duration_ms?: number;
};

/** Daily summary */
export type DailySummary = {
  date: string; // YYYY-MM-DD
  total_runs: number;
  outcomes: Record<RunOutcome, number>;
  domains: Record<TriageDomain, number>;
  automation_levels: Record<AutomationLevel, number>;
  tool_error_frequency: number;
  tool_error_count: number;
  tool_call_count: number;
  delegation_count: number;
  delegation_failures: number;
  escalations: number;
  flow_trace_ids: TraceId[];
  child_trace_ids: TraceId[];
};

/** Weekly summary */
export type WeeklySummary = {
  week_start: string; // YYYY-MM-DD
  week_end: string; // YYYY-MM-DD
  daily_counts: number[];
  avg_runs_per_day: number;
  total_tool_errors: number;
  total_escalations: number;
  top_failure_domains: TriageDomain[];
  top_failure_tools: string[];
};

/** Manifest file content */
export type MetaHarnessManifest = {
  version: string;
  created_at: string;
  workspace_path: string;
};

/** Workspace gating result */
export type GatingResult =
  | { enabled: true; manifest: MetaHarnessManifest }
  | { enabled: false; reason: string };
