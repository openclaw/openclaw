import { z } from "zod";

import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runAgentStep } from "../../agents/tools/agent-step.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import type { OverseerPlan } from "./store.types.js";

const DEFAULT_MAX_PHASES = 5;
const DEFAULT_MAX_TASKS = 7;
const DEFAULT_MAX_SUBTASKS = 7;
const DEFAULT_MAX_REPAIR = 2;

const SubtaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  objective: z.string().optional(),
  outcome: z.string().optional(),
  acceptance: z.array(z.string()).min(1),
  deps: z.array(z.string()).optional(),
});

const TaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  objective: z.string().optional(),
  outcome: z.string().optional(),
  acceptance: z.array(z.string()).min(1),
  deps: z.array(z.string()).optional(),
  subtasks: z.array(SubtaskSchema),
});

const PhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  objective: z.string().optional(),
  tasks: z.array(TaskSchema),
});

const PlanSchema = z.object({
  planVersion: z.number().int().min(1),
  goal: z
    .object({
      title: z.string().optional(),
      successCriteria: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
    })
    .optional(),
  phases: z.array(PhaseSchema),
});

export type PlannerResult = {
  plan: OverseerPlan;
  rawJson: unknown;
  validationErrors: string[];
  promptTemplateId: string;
  promptTemplateHash: string;
};

function buildPrompt(params: {
  goalTitle: string;
  problemStatement: string;
  successCriteria: string[];
  constraints: string[];
  repoContextSnapshot?: string;
  maxPhases: number;
  maxTasksPerPhase: number;
  maxSubtasksPerTask: number;
}) {
  return [
    "You are OverseerPlanner. Decompose the following goal into a 3-tier plan:",
    "Phases -> Tasks -> Subtasks.",
    "",
    "Requirements:",
    "- Output MUST be valid JSON only (no markdown).",
    `- Use at most ${params.maxPhases} phases, ${params.maxTasksPerPhase} tasks per phase, ${params.maxSubtasksPerTask} subtasks per task.`,
    "- Every node must have: id, name, objective/outcome, acceptance (array of strings).",
    "- Include deps as arrays of ids when relevant.",
    "- Keep acceptance criteria testable/verifiable.",
    "",
    "Goal:",
    params.goalTitle,
    "",
    "Problem statement:",
    params.problemStatement,
    "",
    "Success criteria:",
    JSON.stringify(params.successCriteria, null, 2),
    "",
    "Constraints:",
    JSON.stringify(params.constraints, null, 2),
    "",
    "Repo context snapshot:",
    params.repoContextSnapshot ?? "",
  ].join("\n");
}

function buildRepairPrompt(params: { errors: string[]; previousOutput: string }) {
  return [
    "Your previous output was invalid JSON or did not match the required schema.",
    "Return ONLY corrected JSON that matches the schema exactly. Do not add commentary.",
    "",
    "Validation errors:",
    params.errors.join("\n"),
    "",
    "Previous output:",
    params.previousOutput,
  ].join("\n");
}

function summarizeErrors(err: unknown): string[] {
  if (!err) return ["unknown error"];
  if (err instanceof Error) return [err.message];
  if (Array.isArray(err)) return err.map((e) => String(e));
  if (typeof err === "string") return [err];
  try {
    return [JSON.stringify(err)];
  } catch {
    return ["unknown error"];
  }
}

function enforcePlanBounds(
  parsed: z.infer<typeof PlanSchema>,
  maxes: {
    maxPhases: number;
    maxTasks: number;
    maxSubtasks: number;
  },
): string[] {
  const errors: string[] = [];
  if (parsed.phases.length > maxes.maxPhases) {
    errors.push(`phases exceeds maxPhases (${parsed.phases.length} > ${maxes.maxPhases})`);
  }
  for (const phase of parsed.phases) {
    if (phase.tasks.length > maxes.maxTasks) {
      errors.push(
        `tasks exceeds maxTasks (${phase.tasks.length} > ${maxes.maxTasks}) in ${phase.id}`,
      );
    }
    for (const task of phase.tasks) {
      if (task.subtasks.length > maxes.maxSubtasks) {
        errors.push(
          `subtasks exceeds maxSubtasks (${task.subtasks.length} > ${maxes.maxSubtasks}) in ${task.id}`,
        );
      }
    }
  }
  return errors;
}

function normalizePlan(parsed: z.infer<typeof PlanSchema>): OverseerPlan {
  return {
    planVersion: parsed.planVersion,
    phases: parsed.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      objective: phase.objective,
      expectedOutcome: undefined,
      acceptanceCriteria: [],
      definitionOfDone: undefined,
      dependsOn: [],
      blocks: [],
      status: "todo",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        name: task.name,
        objective: task.objective,
        expectedOutcome: task.outcome,
        acceptanceCriteria: task.acceptance,
        definitionOfDone: undefined,
        dependsOn: task.deps ?? [],
        blocks: [],
        status: "todo",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        subtasks: task.subtasks.map((subtask) => ({
          id: subtask.id,
          name: subtask.name,
          objective: subtask.objective,
          expectedOutcome: subtask.outcome,
          acceptanceCriteria: subtask.acceptance,
          dependsOn: subtask.deps ?? [],
          blocks: [],
          status: "todo",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      })),
    })),
  };
}

export async function generateOverseerPlan(params: {
  goalTitle: string;
  problemStatement: string;
  successCriteria: string[];
  constraints: string[];
  repoContextSnapshot?: string;
  agentId?: string;
}): Promise<PlannerResult> {
  const cfg = loadConfig();
  const plannerCfg = cfg.overseer?.planner;
  const model = plannerCfg?.model?.trim();
  if (!model) {
    throw new Error("overseer planner model not configured");
  }
  const maxPhases = plannerCfg?.maxPlanPhases ?? DEFAULT_MAX_PHASES;
  const maxTasksPerPhase = plannerCfg?.maxTasksPerPhase ?? DEFAULT_MAX_TASKS;
  const maxSubtasksPerTask = plannerCfg?.maxSubtasksPerTask ?? DEFAULT_MAX_SUBTASKS;
  const maxRepairAttempts = plannerCfg?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR;
  const agentId = normalizeAgentId(params.agentId);

  const promptTemplateId = "overseer.plan.v1";
  const promptTemplateHash = "overseer.plan.v1";
  const prompt = buildPrompt({
    goalTitle: params.goalTitle,
    problemStatement: params.problemStatement,
    successCriteria: params.successCriteria,
    constraints: params.constraints,
    repoContextSnapshot: params.repoContextSnapshot,
    maxPhases,
    maxTasksPerPhase,
    maxSubtasksPerTask,
  });

  let validationErrors: string[] = [];
  let lastOutput = "";
  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    const sessionKey = `agent:${agentId}:overseer:planner`;
    const message =
      attempt === 0
        ? prompt
        : buildRepairPrompt({ errors: validationErrors, previousOutput: lastOutput });
    const reply = await runAgentStep({
      sessionKey,
      message,
      extraSystemPrompt: "You are OverseerPlanner. Reply with JSON only.",
      timeoutMs: 60_000,
      lane: AGENT_LANE_SUBAGENT,
    });
    lastOutput = reply ?? "";
    if (!lastOutput.trim()) {
      validationErrors = ["empty planner output"];
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastOutput);
    } catch (err) {
      validationErrors = summarizeErrors(err);
      continue;
    }
    const parsedResult = PlanSchema.safeParse(parsed);
    if (!parsedResult.success) {
      validationErrors = parsedResult.error.issues.map((e: { message: string }) => e.message);
      continue;
    }
    const boundErrors = enforcePlanBounds(parsedResult.data, {
      maxPhases,
      maxTasks: maxTasksPerPhase,
      maxSubtasks: maxSubtasksPerTask,
    });
    if (boundErrors.length > 0) {
      validationErrors = boundErrors;
      continue;
    }
    return {
      plan: normalizePlan(parsedResult.data),
      rawJson: parsed,
      validationErrors,
      promptTemplateId,
      promptTemplateHash,
    };
  }
  throw new Error(`overseer planner failed: ${validationErrors.join("; ")}`);
}
