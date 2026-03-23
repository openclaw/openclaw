/**
 * Builds a concise workspace context block for injection into the agent system prompt.
 * Keeps the payload small (≤800 chars) to avoid token budget pressure.
 * Intended for "full" prompt mode only — skip for cron/subagent sessions.
 */
import { listGoals } from "./goal-store-sqlite.js";
import { listTasks } from "./task-store-sqlite.js";
import { getWorkspace } from "./workspace-store-sqlite.js";

export function buildWorkspaceContextBlock(workspaceId: string): string | undefined {
  try {
    const workspace = getWorkspace(workspaceId);
    if (!workspace || workspace.status === "archived") {
      return undefined;
    }

    const lines: string[] = [
      `## Workspace Context`,
      `Workspace: ${workspace.name} (${workspace.id})`,
    ];

    // Up to 5 in-progress goals
    const activeGoals = listGoals({ workspaceId, status: "in_progress" });
    if (activeGoals.length > 0) {
      lines.push(`Active Goals:`);
      for (const g of activeGoals.slice(0, 5)) {
        lines.push(`- ${g.title}`);
      }
    }

    // Pending tasks with details — so agents can act on them without needing to call tasks.list
    const todoTasks = listTasks({ workspaceId, status: "todo" });
    const inProgressTasks = listTasks({ workspaceId, status: "in_progress" });

    if (todoTasks.length > 0) {
      lines.push(`Pending Tasks (todo — action required):`);
      for (const t of todoTasks.slice(0, 5)) {
        const assignee = t.assigneeAgentId ? ` [assigned: ${t.assigneeAgentId}]` : " [unassigned]";
        lines.push(`- ${t.identifier}: ${t.title}${assignee}`);
      }
      if (todoTasks.length > 5) {
        lines.push(`  ... and ${todoTasks.length - 5} more`);
      }
    }

    if (inProgressTasks.length > 0) {
      lines.push(`In-Progress Tasks:`);
      for (const t of inProgressTasks.slice(0, 5)) {
        const assignee = t.assigneeAgentId ? ` [${t.assigneeAgentId}]` : "";
        lines.push(`- ${t.identifier}: ${t.title}${assignee}`);
      }
    }

    if (todoTasks.length === 0 && inProgressTasks.length === 0) {
      lines.push(`Tasks: none pending`);
    }

    // Budget usage if a monthly budget is configured
    if (workspace.budgetMonthlyMicrocents && workspace.budgetMonthlyMicrocents > 0) {
      const pct = Math.round(
        (workspace.spentMonthlyMicrocents / workspace.budgetMonthlyMicrocents) * 100,
      );
      lines.push(`Budget: ${pct}% used this month`);
    }

    const block = lines.join("\n");
    // Hard cap to protect token budget (1500 chars to fit task details)
    return block.length > 1500 ? `${block.slice(0, 1497)}...` : block;
  } catch {
    // Non-fatal: skip workspace context if lookup fails
    return undefined;
  }
}
