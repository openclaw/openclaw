import { promises as fs } from "node:fs";
import path from "node:path";
import type { GoalFile, GoalPhase, PhaseStatus } from "./types.js";

type GoalPhaseInput = Partial<GoalPhase> & {
  id?: string;
  name?: string;
  status?: PhaseStatus;
  passes?: boolean;
};

type GoalInput = Omit<GoalFile, "phases"> & {
  phases?: GoalPhaseInput[];
};

function normalizePhaseStatus(input: GoalPhaseInput): PhaseStatus {
  if (input.status) {
    return input.status;
  }
  if (typeof input.passes === "boolean") {
    return input.passes ? "complete" : "pending";
  }
  return "pending";
}

function normalizePhase(input: GoalPhaseInput): GoalPhase {
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim();
  if (!id || !name) {
    throw new Error(`invalid phase: id and name are required (id=${id}, name=${name})`);
  }

  const status = normalizePhaseStatus(input);
  const passes = status === "complete";

  return {
    id,
    name,
    status,
    passes,
    description: input.description,
    prompt: input.prompt,
    notes: input.notes,
    verification: input.verification,
    artifacts: input.artifacts,
    requiresApproval: input.requiresApproval,
  };
}

function normalizeGoal(input: GoalInput): GoalFile {
  if (!input.title?.trim()) {
    throw new Error("goal.title is required");
  }
  if (!input.workdir?.trim()) {
    throw new Error("goal.workdir is required");
  }
  const phases = (input.phases ?? []).map(normalizePhase);
  if (phases.length === 0) {
    throw new Error("goal.phases must include at least one phase");
  }

  return {
    title: input.title,
    workdir: input.workdir,
    tool: input.tool ?? "codex",
    status: input.status ?? "pending",
    phases,
    infiniteLoop: Boolean(input.infiniteLoop),
    session: input.session,
    awaitingApproval: input.awaitingApproval,
    orchestration: input.orchestration,
  };
}

export async function loadGoalFile(goalFile: string): Promise<GoalFile> {
  const raw = await fs.readFile(goalFile, "utf8");
  const parsed = JSON.parse(raw) as GoalInput;
  return normalizeGoal(parsed);
}

export async function saveGoalFile(goalFile: string, goal: GoalFile): Promise<void> {
  const next = {
    ...goal,
    phases: goal.phases.map((phase) => ({
      ...phase,
      status: phase.status,
      passes: phase.status === "complete",
    })),
  };
  await fs.mkdir(path.dirname(goalFile), { recursive: true });
  await fs.writeFile(goalFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function getCurrentPhase(goal: GoalFile): GoalPhase | undefined {
  return goal.phases.find((phase) => phase.status !== "complete");
}

export function updatePhaseStatus(goal: GoalFile, phaseId: string, status: PhaseStatus): GoalFile {
  const phases = goal.phases.map((phase) => {
    if (phase.id !== phaseId) {
      return phase;
    }
    return {
      ...phase,
      status,
      passes: status === "complete",
    };
  });

  const allComplete = phases.every((phase) => phase.status === "complete");
  return {
    ...goal,
    phases,
    status: allComplete ? "complete" : goal.status,
  };
}

export function buildPhasePrompt(goal: GoalFile, phase: GoalPhase): string {
  const artifacts = phase.artifacts?.length ? phase.artifacts.join(", ") : "(none)";
  const verification = phase.verification ?? "(none)";
  const notes = phase.notes?.trim();
  const instructions = phase.prompt?.trim();

  const lines = [
    `# Phase: ${phase.id} - ${phase.name}`,
    "",
    phase.description?.trim() || "",
    "",
    "## Expected Artifacts",
    artifacts,
    "",
    "## Verification Criteria",
    verification,
  ];

  if (instructions) {
    lines.push("", "## Instructions", instructions);
  }
  if (notes) {
    lines.push("", "## Notes from previous phases", notes);
  }

  lines.push(
    "",
    "---",
    "**Completion signals** (output on its own line when ready):",
    `- Done: \`PHASE_COMPLETE: ${phase.id}\``,
    "- Blocked: `PHASE_BLOCKED: your reason here`",
    "",
    "Start now.",
  );

  return lines.join("\n");
}

export function ensureApprovalGate(goal: GoalFile, completedPhaseId: string): GoalFile {
  const completed = goal.phases.find((phase) => phase.id === completedPhaseId);
  if (!completed?.requiresApproval) {
    return { ...goal, awaitingApproval: undefined };
  }
  const next = getCurrentPhase(goal);
  if (!next) {
    return goal;
  }
  return {
    ...goal,
    awaitingApproval: next.id,
  };
}
