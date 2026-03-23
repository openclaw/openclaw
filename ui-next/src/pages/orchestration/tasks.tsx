import { ListTodo, Plus, RefreshCw, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

// ── Create Task Dialog ────────────────────────────────────────────────

type TaskForm = {
  title: string;
  description: string;
  priority: string;
  status: string;
  goalId: string;
  projectId: string;
};

const EMPTY_TASK_FORM: TaskForm = {
  title: "",
  description: "",
  priority: "medium",
  status: "backlog",
  goalId: "",
  projectId: "",
};

function CreateTaskDialog({
  open,
  onOpenChange,
  form,
  setForm,
  onSubmit,
  submitting,
  goals,
  projects,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  form: TaskForm;
  setForm: (f: TaskForm) => void;
  onSubmit: () => void;
  submitting: boolean;
  goals: { id: string; title: string }[];
  projects: { id: string; name: string }[];
}) {
  const update = (patch: Partial<TaskForm>) => setForm({ ...form, ...patch });
  const canSubmit = form.title.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Title *</label>
            <Input
              value={form.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="Task title"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Description</label>
            <Input
              value={form.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="Optional description"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Goal</label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus:border-ring cursor-pointer"
              value={form.goalId}
              onChange={(e) => update({ goalId: e.target.value })}
            >
              <option value="">No goal</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Project</label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus:border-ring cursor-pointer"
              value={form.projectId}
              onChange={(e) => update({ projectId: e.target.value })}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Priority</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus:border-ring cursor-pointer"
                value={form.priority}
                onChange={(e) => update({ priority: e.target.value })}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Status</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus:border-ring cursor-pointer"
                value={form.status}
                onChange={(e) => update({ status: e.target.value })}
              >
                <option value="backlog">backlog</option>
                <option value="todo">todo</option>
              </select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function TasksPage() {
  const navigate = useNavigate();
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [goals, setGoals] = useState<{ id: string; title: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<"all" | "mine" | "unassigned">("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<TaskForm>(EMPTY_TASK_FORM);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  // Client-side assignee filter applied on top of server-filtered results
  const tasks = useMemo(() => {
    if (assigneeFilter === "mine") {
      return allTasks.filter((t) => t.assigneeAgentId === "main");
    }
    if (assigneeFilter === "unassigned") {
      return allTasks.filter((t) => !t.assigneeAgentId);
    }
    return allTasks;
  }, [allTasks, assigneeFilter]);

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
      sendRpc<{ goals: { id: string; title: string }[] }>("goals.list", {}),
      sendRpc<{ projects: { id: string; name: string }[] }>("projects.list", {}).catch(() => ({
        projects: [],
      })),
    ])
      .then(([taskRes, wsRes, goalsRes, projectsRes]) => {
        setAllTasks(taskRes.tasks ?? []);
        setWorkspaces(wsRes.workspaces ?? []);
        setGoals(goalsRes.goals ?? []);
        setProjects(projectsRes.projects ?? []);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sendRpc, workspaceFilter, statusFilter]);

  useEffect(() => {
    if (isConnected) {
      loadData();
    }
  }, [isConnected, loadData]);

  const handleCreate = () => {
    setCreateSubmitting(true);
    sendRpc("tasks.create", {
      workspaceId: "default",
      title: createForm.title.trim(),
      description: createForm.description.trim() || undefined,
      priority: createForm.priority,
      status: createForm.status,
      goalId: createForm.goalId || undefined,
      projectId: createForm.projectId || undefined,
    })
      .then(() => {
        setCreateOpen(false);
        setCreateForm(EMPTY_TASK_FORM);
        loadData();
      })
      .catch((err) => setError(String(err)))
      .finally(() => setCreateSubmitting(false));
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCreateForm(EMPTY_TASK_FORM);
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-1 size-3.5" />
            Create Task
          </Button>
        </div>
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

        {/* Assignee quick-filters */}
        <div className="flex flex-wrap gap-1 border-l border-border pl-2">
          <Button
            size="sm"
            variant={assigneeFilter === "mine" ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() => setAssigneeFilter(assigneeFilter === "mine" ? "all" : "mine")}
          >
            My Tasks
          </Button>
          <Button
            size="sm"
            variant={assigneeFilter === "unassigned" ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() =>
              setAssigneeFilter(assigneeFilter === "unassigned" ? "all" : "unassigned")
            }
          >
            Unassigned
          </Button>
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
          onRowClick={(row) => void navigate(`/tasks/${row.id}`)}
        />
      )}

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        form={createForm}
        setForm={setCreateForm}
        onSubmit={handleCreate}
        submitting={createSubmitting}
        goals={goals}
        projects={projects}
      />
    </div>
  );
}
