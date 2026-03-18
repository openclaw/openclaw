import { Target, ListTodo, DollarSign, Bell } from "lucide-react";
import { cn } from "@/lib/utils";

interface OrgWorkspaceBarProps {
  workspaceName: string;
  brandColor?: string | null;
  tasksInProgress: number;
  activeGoals: number;
  /** Budget percent used (0-100). Pass -1 when no budget is configured. */
  budgetPctUsed: number;
  pendingApprovals: number;
}

export function OrgWorkspaceBar({
  workspaceName,
  brandColor,
  tasksInProgress,
  activeGoals,
  budgetPctUsed,
  pendingApprovals,
}: OrgWorkspaceBarProps) {
  const color = brandColor ?? "#64748b";

  return (
    <div
      className="flex items-center gap-4 px-3 py-2 mb-2 rounded-lg border bg-card/60 text-xs flex-wrap"
      style={{ borderColor: `${color}50` }}
    >
      {/* Workspace name */}
      <div className="flex items-center gap-1.5 font-medium">
        <div className="size-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
        {workspaceName}
      </div>

      <div className="h-3 w-px bg-border" />

      {/* Tasks in progress */}
      <div className="flex items-center gap-1 text-muted-foreground">
        <ListTodo className="size-3" />
        <span>
          {tasksInProgress} task{tasksInProgress !== 1 ? "s" : ""} in progress
        </span>
      </div>

      {/* Active goals */}
      <div className="flex items-center gap-1 text-muted-foreground">
        <Target className="size-3" />
        <span>
          {activeGoals} active goal{activeGoals !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Budget bar */}
      {budgetPctUsed >= 0 && (
        <>
          <div className="h-3 w-px bg-border" />
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <DollarSign className="size-3" />
            <div className="flex items-center gap-1.5">
              <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    budgetPctUsed >= 90
                      ? "bg-red-500"
                      : budgetPctUsed >= 75
                        ? "bg-amber-500"
                        : "bg-green-500",
                  )}
                  style={{ width: `${Math.min(budgetPctUsed, 100)}%` }}
                />
              </div>
              <span>{budgetPctUsed}% budget used</span>
            </div>
          </div>
        </>
      )}

      {/* Pending approvals badge */}
      {pendingApprovals > 0 && (
        <>
          <div className="h-3 w-px bg-border" />
          <div className="flex items-center gap-1 text-amber-500 font-medium">
            <Bell className="size-3" />
            <span>
              {pendingApprovals} pending approval{pendingApprovals !== 1 ? "s" : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
