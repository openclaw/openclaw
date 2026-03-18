import { X, Loader2, CheckCircle2, Circle, Clock, Ban, ListTodo } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
}

interface ActivityLog {
  id: number;
  action: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  createdAt: number;
  detailsJson?: string;
}

interface AgentMetricsData {
  tasksInProgress: number;
  tasksCompleted: number;
  totalCostMicrocents: number;
}

interface OrgAgentPanelProps {
  agentId: string;
  agentName: string;
  department: string;
  departmentColor: string;
  workspaceId: string;
  workspaceName: string;
  agentStatus?: "active" | "inactive" | "paused";
  metrics?: AgentMetricsData;
  onClose: () => void;
  onStatusChange: (
    agentId: string,
    workspaceId: string,
    status: "active" | "inactive" | "paused",
  ) => void;
  onWorkspaceRemove: (agentId: string, workspaceId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-blue-400",
  in_progress: "text-amber-400",
  in_review: "text-purple-400",
  blocked: "text-red-400",
  done: "text-green-500",
  cancelled: "text-muted-foreground line-through",
};

const PRIORITY_DOTS: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-400",
  medium: "bg-amber-400",
  low: "bg-slate-400",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "done") {
    return <CheckCircle2 className="size-3 text-green-500 shrink-0" />;
  }
  if (status === "cancelled") {
    return <Ban className="size-3 text-muted-foreground shrink-0" />;
  }
  if (status === "in_progress") {
    return <Clock className="size-3 text-amber-400 shrink-0" />;
  }
  return <Circle className="size-3 text-muted-foreground shrink-0" />;
}

function formatMicrocents(mc: number): string {
  const dollars = mc / 1_000_000;
  if (dollars < 0.01) {
    return "< $0.01";
  }
  return `$${dollars.toFixed(2)}`;
}

function timeAgo(unixSecs: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60) {
    return "just now";
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  if (diff < 86400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }
  return `${Math.floor(diff / 86400)}d ago`;
}

export function OrgAgentPanel({
  agentId,
  agentName,
  department,
  departmentColor,
  workspaceId,
  workspaceName,
  agentStatus,
  metrics,
  onClose,
  onStatusChange,
  onWorkspaceRemove,
}: OrgAgentPanelProps) {
  const { sendRpc } = useGateway();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [activeTab, setActiveTab] = useState<"tasks" | "activity">("tasks");
  const [statusChanging, setStatusChanging] = useState(false);

  const fetchData = useCallback(async () => {
    setLoadingTasks(true);
    setLoadingActivity(true);

    const [tasksRes, activityRes] = await Promise.all([
      sendRpc<{ tasks?: Task[] }>("tasks.list", {
        workspaceId,
        assigneeAgentId: agentId,
      }).catch(() => null),
      sendRpc<{ logs?: ActivityLog[] }>("activityLogs.list", {
        workspaceId,
        actorId: agentId,
        limit: 15,
      }).catch(() => null),
    ]);

    setTasks(Array.isArray(tasksRes?.tasks) ? tasksRes.tasks : []);
    setActivity(Array.isArray(activityRes?.logs) ? activityRes.logs : []);
    setLoadingTasks(false);
    setLoadingActivity(false);
  }, [sendRpc, workspaceId, agentId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleStatusChange = async (newStatus: "active" | "inactive" | "paused") => {
    setStatusChanging(true);
    try {
      await sendRpc("workspaces.updateAgentStatus", {
        workspaceId,
        agentId,
        status: newStatus,
      });
      onStatusChange(agentId, workspaceId, newStatus);
    } finally {
      setStatusChanging(false);
    }
  };

  const activeTasks = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
  const doneTasks = tasks.filter((t) => t.status === "done");

  return (
    <div className="absolute top-0 right-0 h-full w-72 bg-card border-l shadow-xl z-20 flex flex-col">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderLeftColor: departmentColor, borderLeftWidth: 3 }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: departmentColor }}
            />
            <span className="font-semibold text-sm truncate">{agentName}</span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {department} · {workspaceName}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground ml-2 shrink-0"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Metrics strip */}
      <div className="px-4 py-2.5 border-b grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-sm font-semibold">{metrics?.tasksInProgress ?? 0}</div>
          <div className="text-[10px] text-muted-foreground">Active</div>
        </div>
        <div>
          <div className="text-sm font-semibold">{metrics?.tasksCompleted ?? 0}</div>
          <div className="text-[10px] text-muted-foreground">Done</div>
        </div>
        <div>
          <div className="text-sm font-semibold">
            {metrics ? formatMicrocents(metrics.totalCostMicrocents) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">Cost</div>
        </div>
      </div>

      {/* Agent status toggle */}
      <div className="px-4 py-2 border-b flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Status:</span>
        {(["active", "inactive", "paused"] as const).map((s) => (
          <button
            key={s}
            disabled={statusChanging}
            onClick={() => void handleStatusChange(s)}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full border transition-colors capitalize",
              agentStatus === s
                ? s === "active"
                  ? "bg-green-500/20 border-green-500/50 text-green-400"
                  : s === "paused"
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-400"
                    : "bg-muted border-border text-muted-foreground"
                : "border-transparent text-muted-foreground hover:border-border",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex border-b">
        {(["tasks", "activity"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 py-2 text-xs font-medium transition-colors capitalize",
              activeTab === tab
                ? "border-b-2 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            style={activeTab === tab ? { borderBottomColor: departmentColor } : undefined}
          >
            {tab === "tasks" ? (
              <span className="flex items-center justify-center gap-1">
                <ListTodo className="size-3" />
                Tasks {tasks.length > 0 && `(${tasks.length})`}
              </span>
            ) : (
              "Activity"
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "tasks" && (
          <div>
            {loadingTasks ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : tasks.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No tasks assigned
              </div>
            ) : (
              <>
                {activeTasks.length > 0 && (
                  <div>
                    <div className="px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
                      Active ({activeTasks.length})
                    </div>
                    {activeTasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-start gap-2 px-4 py-2 border-b border-border/40 hover:bg-muted/20"
                      >
                        <StatusIcon status={task.status} />
                        <div className="min-w-0 flex-1">
                          <div className={cn("text-xs truncate", STATUS_COLORS[task.status] ?? "")}>
                            {task.title}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {task.identifier}
                            </span>
                            <div
                              className={cn(
                                "size-1.5 rounded-full shrink-0",
                                PRIORITY_DOTS[task.priority] ?? "bg-muted",
                              )}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {doneTasks.length > 0 && (
                  <div>
                    <div className="px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/30">
                      Completed ({doneTasks.length})
                    </div>
                    {doneTasks.slice(0, 5).map((task) => (
                      <div
                        key={task.id}
                        className="flex items-start gap-2 px-4 py-2 border-b border-border/40 opacity-60"
                      >
                        <StatusIcon status={task.status} />
                        <div className="text-xs truncate text-muted-foreground">{task.title}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "activity" && (
          <div>
            {loadingActivity ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : activity.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No recent activity
              </div>
            ) : (
              activity.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 px-4 py-2 border-b border-border/40"
                >
                  <div className="size-1.5 rounded-full bg-muted-foreground/50 shrink-0 mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-foreground capitalize">
                      {entry.action.replace(/_/g, " ")}
                      {entry.entityType && (
                        <span className="text-muted-foreground"> · {entry.entityType}</span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {timeAgo(entry.createdAt)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="px-4 py-3 border-t flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-xs h-7 hover:text-destructive hover:border-destructive/50"
          onClick={() => onWorkspaceRemove(agentId, workspaceId)}
        >
          Remove from workspace
        </Button>
      </div>
    </div>
  );
}
