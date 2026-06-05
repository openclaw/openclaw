export const META_STEP_KINDS = [
  "agent",
  "llm_classify",
  "llm_chat",
  "skill_exec",
  "tool_call",
  "user_input",
] as const;

export type MetaStepKind = (typeof META_STEP_KINDS)[number];

export const META_BLOCKED_TOOL_CALL_TARGET_NAMES = [
  "meta_invoke",
  "tool_call",
  "tool_describe",
  "tool_search",
  "tool_search_code",
] as const;

export type MetaFinalTextMode =
  | { kind: "auto" }
  | { kind: "raw" }
  | { kind: "step"; stepId: string };

export type MetaFailureAttempt = {
  prompt?: string;
  toolName?: string;
  skillName?: string;
  args?: Record<string, unknown>;
  choices?: string[];
  schema?: Record<string, unknown>;
};

export type MetaFailurePolicy =
  | { kind: "fail" }
  | { kind: "skip" }
  | { kind: "substitute"; output: Record<string, unknown> }
  | { kind: "failover"; attempts: MetaFailureAttempt[]; maxAttempts: number };

export type MetaWhenExpression =
  | { kind: "truthy"; path: string }
  | { kind: "equals"; path: string; value: unknown }
  | { kind: "not_equals"; path: string; value: unknown }
  | { kind: "in"; path: string; values: unknown[] };

export type MetaRouteCases = {
  path: string;
  cases: Record<string, string[]>;
  default?: string[];
};

export type MetaTrigger = {
  pattern: string;
};

export type MetaStep = {
  id: string;
  kind: MetaStepKind;
  dependsOn: string[];
  prompt?: string;
  toolName?: string;
  skillName?: string;
  args?: Record<string, unknown>;
  choices?: string[];
  schema?: Record<string, unknown>;
  when?: MetaWhenExpression;
  route?: MetaRouteCases;
  onFailure: MetaFailurePolicy;
};

export type MetaPlan = {
  name: string;
  description: string;
  triggers: MetaTrigger[];
  riskMetadata?: Record<string, unknown>;
  steps: MetaStep[];
  finalTextMode: MetaFinalTextMode;
  sourceFilePath?: string;
};

export type MetaDiagnostic = {
  skillName: string;
  filePath?: string;
  message: string;
};

export type MetaStepStatus = "pending" | "running" | "succeeded" | "skipped" | "failed" | "paused";

export type MetaRunStatus = "running" | "succeeded" | "failed" | "paused" | "cancelled";
