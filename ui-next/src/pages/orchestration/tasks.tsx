import { ListTodo, RefreshCw, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ─────────────────────────────────────────────────────────────

type Task = {
  id: string;
  workspaceId: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string;
  createdAt: number;
  updatedAt: number;
};

type Workspace = { id: string; name: string };

type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

const STATUS_FILTERS: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

// ── Helpers ───────────────────────────────────────────────────────────

function statusStyle(status: string): string {
  switch (status) {
    case "backlog":
      return "bg-muted text-muted-foreground border-border";
    case "todo":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "in_progress":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "in_review":
      return "bg-purple-500/15 text-purple-400 border-purple-500/30";
    case "done":
      return "bg-green-500/15 text-green-400 border-green-500/30";
    case "blocked":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "cancelled":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function priorityStyle(priority: string): string {
  switch (priority) {
    case "urgent":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "high":
      return "bg-orange-500/15 text-orange-400 border-orange-500/30";
    case "medium":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "low":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        statusStyle(status),
        status === "cancelled" && "line-through opacity-70",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  if (!priority) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        priorityStyle(priority),
      )}
    >
      {priority}
    </span>
  );
}

const ALL_STATUSES: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

// ── Detail Dialog ─────────────────────────────────────────────────────

function TaskDetailDialog({
  task,
  onClose,
  onStatusChange,
}: {
  task: Task | null;
  onClose: () => void;
  onStatusChange: (id: string, status: string) => void;
}) {
  if (!task) {
    return null;
  }
  return (
    <Dialog
      open={task !== null}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="font-mono text-sm text-muted-foreground">{task.identifier}</span>{" "}
            {task.title}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2 text-sm">
          <div className="flex gap-4">
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <StatusBadge status={task.status} />
            </div>
            <div>
              <span className="text-muted-foreground">Priority:</span>{" "}
              <PriorityBadge priority={task.priority} />
            </div>
          </div>
          {task.assigneeAgentId && (
            <div>
              <span className="text-muted-foreground">Assignee:</span>{" "}
              <span className="font-mono text-xs">{task.assigneeAgentId}</span>
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Updated:</span>{" "}
            {new Date(task.updatedAt * 1000).toLocaleString()}
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium text-muted-foreground">Update Status</label>
            <div className="flex flex-wrap gap-1">
              {ALL_STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={task.status === s ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={() => onStatusChange(task.id, s)}
                >
                  {s.replace("_", " ")}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function TasksPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [tasks, setTasks] = useState<Task[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [detailTask, setDetailTask] = useState<Task | null>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, string> = {};
    if (workspaceFilter !== "all") {
      params.workspaceId = workspaceFilter;
    }
    if (statusFilter !== "all") {
      params.status = statusFilter;
    }

    Promise.all([
      sendRpc<{ tasks: Task[] }>("tasks.list", params),
      sendRpc<{ workspaces: Workspace[] }>("workspaces.list"),
    ])
      .then(([taskRes, wsRes]) => {
        setTasks(taskRes.tasks ?? []);
        setWorkspaces(wsRes.workspaces ?? []);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sendRpc, workspaceFilter, statusFilter]);

  useEffect(() => {
    if (isConnected) {
      loadData();
    }
  }, [isConnected, loadData]);

  const handleStatusChange = (id: string, status: string) => {
    sendRpc("tasks.update", { id, status })
      .then(() => {
        setDetailTask((prev) => (prev?.id === id ? { ...prev, status } : prev));
        loadData();
      })
      .catch((err) => setError(String(err)));
  };

  const columns: Column<Task>[] = [
    {
      key: "identifier",
      header: "ID",
      sortable: true,
      render: (row) => (
        <span className="font-mono text-xs text-muted-foreground">{row.identifier}</span>
      ),
    },
    {
      key: "title",
      header: "Title",
      sortable: true,
      render: (row) => <span className="font-medium">{row.title}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "priority",
      header: "Priority",
      sortable: true,
      render: (row) => <PriorityBadge priority={row.priority} />,
    },
    {
      key: "assigneeAgentId",
      header: "Assignee",
      render: (row) =>
        row.assigneeAgentId ? (
          <span className="font-mono text-xs text-muted-foreground" title={row.assigneeAgentId}>
            {row.assigneeAgentId.slice(0, 12)}…
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "updatedAt",
      header: "Updated",
      sortable: true,
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.updatedAt * 1000).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListTodo className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Tasks</h2>
          <span className="text-sm text-muted-foreground">({tasks.length})</span>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring cursor-pointer"
          value={workspaceFilter}
          onChange={(e) => setWorkspaceFilter(e.target.value)}
        >
          <option value="all">All Workspaces</option>
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>

        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={statusFilter === "all" ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() => setStatusFilter("all")}
          >
            All
          </Button>
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={statusFilter === s ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setStatusFilter(s)}
            >
              {s.replace("_", " ")}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DataTable<Task>
          columns={columns}
          data={tasks}
          keyField="id"
          emptyMessage="No tasks found."
          pageSize={25}
          compact
          onRowClick={(row) => setDetailTask(row)}
        />
      )}

      <TaskDetailDialog
        task={detailTask}
        onClose={() => setDetailTask(null)}
        onStatusChange={handleStatusChange}
      />
    </div>
  );
}
