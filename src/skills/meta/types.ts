export const META_STEP_KINDS = [
  "agent",
  "llm_classify",
  "llm_chat",
  "skill_exec",
  "tool_call",
  "user_input",
] as const;

export type MetaStepKind = (typeof META_STEP_KINDS)[number];

export type MetaFinalTextMode =
  | { kind: "auto" }
  | { kind: "raw" }
  | { kind: "step"; stepId: string };

export type MetaFailurePolicy =
  | { kind: "fail" }
  | { kind: "skip" }
  | { kind: "substitute"; output: Record<string, unknown> };

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
  onFailure: MetaFailurePolicy;
};

export type MetaPlan = {
  name: string;
  description: string;
  triggers: MetaTrigger[];
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
