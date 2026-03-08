import { createSubsystemLogger } from "../logging/subsystem.js";
import { createWorkflowStoreManager } from "./store.js";
import { formatWorkflowSummary, getWorkflowProgress, type WorkflowPlan } from "./types.js";

const log = createSubsystemLogger("workflow/heartbeat");

export type HeartbeatWorkflowContext = {
  agentId: string;
  sessionKey?: string;
};

export type HeartbeatWorkflowStatus = {
  hasActivePlan: boolean;
  activePlan?: WorkflowPlan;
  progress?: {
    completed: number;
    total: number;
    percent: number;
  };
  summary?: string;
};

export async function getHeartbeatWorkflowStatus(
  ctx: HeartbeatWorkflowContext,
): Promise<HeartbeatWorkflowStatus> {
  try {
    const manager = createWorkflowStoreManager(ctx.agentId);
    const plans = await manager.getActivePlans();

    // Find the most recent active plan for this session
    const sessionPlans = ctx.sessionKey
      ? plans.filter((p) => p.sessionKey === ctx.sessionKey || !p.sessionKey)
      : plans;

    const activePlan = sessionPlans.find(
      (p) => p.status === "in_progress" || p.status === "pending",
    );

    if (!activePlan) {
      return { hasActivePlan: false };
    }

    const progress = getWorkflowProgress(activePlan);
    const summary = formatWorkflowSummary(activePlan);

    return {
      hasActivePlan: true,
      activePlan,
      progress,
      summary,
    };
  } catch (err) {
    log.warn("failed to get heartbeat workflow status", { error: String(err) });
    return { hasActivePlan: false };
  }
}

export function buildHeartbeatWorkflowPromptSection(status: HeartbeatWorkflowStatus): string {
  if (!status.hasActivePlan || !status.activePlan) {
    return "";
  }

  const plan = status.activePlan;
  const progress = status.progress ?? getWorkflowProgress(plan);

  const pendingTasks = plan.tasks.filter((t) => t.status === "pending");
  const inProgressTasks = plan.tasks.filter((t) => t.status === "in_progress");

  const lines: string[] = [
    "",
    "## Active Workflow Plan",
    `**${plan.title}** (${progress.completed}/${progress.total} tasks completed, ${progress.percent}%)`,
    "",
  ];

  if (inProgressTasks.length > 0) {
    lines.push("### In Progress:");
    for (const task of inProgressTasks) {
      lines.push(`- [ ] ${task.content} (task_id: ${task.id})`);
    }
    lines.push("");
  }

  if (pendingTasks.length > 0) {
    lines.push("### Pending Tasks:");
    for (const task of pendingTasks.slice(0, 5)) {
      lines.push(`- [ ] ${task.content} (task_id: ${task.id})`);
    }
    if (pendingTasks.length > 5) {
      lines.push(`... and ${pendingTasks.length - 5} more pending tasks`);
    }
    lines.push("");
  }

  lines.push(`Use the workflow tool to update task progress. Plan ID: ${plan.id}`);
  lines.push("");

  return lines.join("\n");
}

export async function appendWorkflowStatusToPrompt(
  ctx: HeartbeatWorkflowContext,
  prompt: string,
): Promise<string> {
  const status = await getHeartbeatWorkflowStatus(ctx);
  const section = buildHeartbeatWorkflowPromptSection(status);

  if (!section) {
    return prompt;
  }

  return prompt + section;
}
