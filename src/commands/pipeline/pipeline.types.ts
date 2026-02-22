export type PipelineVerdict = "PASS" | "WARN" | "FAIL" | "ABORT";

export type PipelineStep = {
  /** Unique id in the pipeline spec (e.g. r1, aSynth, phase-6-gate). */
  id: string;
  /** Phase identifier: "0".."7" or custom like "1-ADV" or "3-V". */
  phase: string;
  /** Human readable label for logs. */
  label?: string;
  /** Model id or alias to run this step on (e.g. openai/gpt-5-mini). */
  model: string;
  /** The task/prompt body (what gets sent to the agent). */
  task: string;

  /** Step kind. */
  kind?: "worker" | "synth" | "gate";

  /** Dependencies by step id. */
  dependsOn?: string[];
  /** Parallel group key. Steps with the same group may run concurrently. */
  group?: string;

  /** Files that must exist before starting this step. */
  requiresFiles?: string[];
  /** Files that must exist after step completion (gating). */
  producesFiles?: string[];

  /** Optional: parse a verdict file produced by this step. */
  verdictFile?: string;
};

export type PipelineCheckpoint = {
  id: string;
  afterPhase: string;
  prompt: string;
  /** When true, runner requires confirmation unless --yes. */
  interactive?: boolean;
};

export type PipelineLoopRule = {
  id: string;
  /** The step id whose verdict controls the loop. */
  verdictStepId: string;
  /** Re-run these step ids when verdict is not PASS. */
  rerunStepIds: string[];
  /** Max iterations to prevent infinite loops. */
  maxIterations?: number;
  /** Only rerun on these verdicts (default: WARN+FAIL). */
  on?: PipelineVerdict[];
};

export type PipelineSpec = {
  schemaVersion: 1;
  name: string;
  runDir: string;
  createdAt: string;

  /** Explicit phase ordering. Steps' `phase` must be in this list. */
  phases: string[];

  /** The agent id to execute steps under (e.g. flash-orchestrator). */
  agentId?: string;

  steps: PipelineStep[];
  checkpoints?: PipelineCheckpoint[];
  loops?: PipelineLoopRule[];
};
