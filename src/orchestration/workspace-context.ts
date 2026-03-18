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

    // Task count summary — in_progress and todo (backlog excluded to keep output concise)
    const inProgressTasks = listTasks({ workspaceId, status: "in_progress" });
    const todoTasks = listTasks({ workspaceId, status: "todo" });
    if (inProgressTasks.length > 0 || todoTasks.length > 0) {
      lines.push(`Tasks: ${inProgressTasks.length} in-progress, ${todoTasks.length} todo`);
    }

    // Budget usage if a monthly budget is configured
    if (workspace.budgetMonthlyMicrocents && workspace.budgetMonthlyMicrocents > 0) {
      const pct = Math.round(
        (workspace.spentMonthlyMicrocents / workspace.budgetMonthlyMicrocents) * 100,
      );
      lines.push(`Budget: ${pct}% used this month`);
    }

    const block = lines.join("\n");
    // Hard cap to protect token budget
    return block.length > 800 ? `${block.slice(0, 797)}...` : block;
  } catch {
    // Non-fatal: skip workspace context if lookup fails
    return undefined;
  }
}
