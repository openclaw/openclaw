import crypto from "node:crypto";

export type WorkflowTaskStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

export type WorkflowPlanStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type WorkflowSource = "heartbeat" | "task" | "manual" | "cron";

export type WorkflowTask = {
  id: string;
  content: string;
  status: WorkflowTaskStatus;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  order: number;
};

export type WorkflowPlan = {
  id: string;
  agentId: string;
  sessionKey?: string;
  title: string;
  description?: string;
  status: WorkflowPlanStatus;
  source: WorkflowSource;
  tasks: WorkflowTask[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  discordReported?: boolean;
  discordReportedAt?: string;
  discordChannelId?: string;
  metadata?: Record<string, unknown>;
};

export type WorkflowStore = {
  version: 1;
  activePlans: Record<string, WorkflowPlan>;
};

export type WorkflowPlanCreate = {
  agentId: string;
  sessionKey?: string;
  title: string;
  description?: string;
  source: WorkflowSource;
  tasks: Array<{ content: string }>;
  metadata?: Record<string, unknown>;
};

export type WorkflowTaskUpdate = {
  planId: string;
  taskId: string;
  status: WorkflowTaskStatus;
  result?: string;
  error?: string;
};

export type WorkflowPlanPatch = Partial<
  Omit<WorkflowPlan, "id" | "createdAt" | "tasks" | "agentId">
>;

export type WorkflowEventType =
  | "plan.created"
  | "plan.updated"
  | "plan.completed"
  | "plan.failed"
  | "task.started"
  | "task.completed"
  | "task.skipped"
  | "task.failed";

export type WorkflowEvent = {
  type: WorkflowEventType;
  planId: string;
  taskId?: string;
  plan?: WorkflowPlan;
  task?: WorkflowTask;
  timestamp: string;
};

export function generateWorkflowPlanId(): string {
  return `wfp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function generateWorkflowTaskId(): string {
  return `wft_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function createWorkflowTask(content: string, order: number): WorkflowTask {
  return {
    id: generateWorkflowTaskId(),
    content,
    status: "pending",
    order,
  };
}

export function createWorkflowPlan(params: WorkflowPlanCreate): WorkflowPlan {
  const now = new Date().toISOString();
  const tasks = params.tasks.map((t, index) => createWorkflowTask(t.content, index));

  return {
    id: generateWorkflowPlanId(),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    title: params.title,
    description: params.description,
    status: "pending",
    source: params.source,
    tasks,
    createdAt: now,
    updatedAt: now,
    metadata: params.metadata,
  };
}

export function getWorkflowProgress(plan: WorkflowPlan): {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  inProgress: number;
  pending: number;
  percent: number;
} {
  const total = plan.tasks.length;
  const completed = plan.tasks.filter((t) => t.status === "completed").length;
  const failed = plan.tasks.filter((t) => t.status === "failed").length;
  const skipped = plan.tasks.filter((t) => t.status === "skipped").length;
  const inProgress = plan.tasks.filter((t) => t.status === "in_progress").length;
  const pending = plan.tasks.filter((t) => t.status === "pending").length;
  const done = completed + failed + skipped;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return { total, completed, failed, skipped, inProgress, pending, percent };
}

export function isWorkflowPlanComplete(plan: WorkflowPlan): boolean {
  return plan.tasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "skipped",
  );
}

export function formatWorkflowSummary(plan: WorkflowPlan): string {
  const progress = getWorkflowProgress(plan);
  const duration =
    plan.completedAt && plan.startedAt
      ? Math.round(
          (new Date(plan.completedAt).getTime() - new Date(plan.startedAt).getTime()) / 1000,
        )
      : null;

  const lines: string[] = [
    `**Workflow Report: ${plan.title}**`,
    "",
    `Status: ${plan.status}`,
    `Progress: ${progress.completed}/${progress.total} tasks completed`,
  ];

  if (progress.failed > 0) {
    lines.push(`Failed: ${progress.failed} task(s)`);
  }
  if (progress.skipped > 0) {
    lines.push(`Skipped: ${progress.skipped} task(s)`);
  }
  if (duration !== null) {
    lines.push(`Duration: ${duration}s`);
  }

  lines.push("", "**Tasks:**");
  for (const task of plan.tasks) {
    const icon =
      task.status === "completed"
        ? "✅"
        : task.status === "failed"
          ? "❌"
          : task.status === "skipped"
            ? "⏭️"
            : "⬜";
    lines.push(`${icon} ${task.content}`);
    if (task.result) {
      lines.push(`   → ${task.result}`);
    }
    if (task.error) {
      lines.push(`   ⚠️ ${task.error}`);
    }
  }

  return lines.join("\n");
}
