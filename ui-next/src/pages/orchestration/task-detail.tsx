import {
  ArrowLeft,
  Loader2,
  MessageSquare,
  Send,
  User,
  Bot,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ─────────────────────────────────────────────────────────────

type Task = {
  id: string;
  workspaceId: string;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  billingCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

type TaskComment = {
  id: string;
  taskId: string;
  authorId: string;
  authorType: string;
  body: string;
  createdAt: number;
};

type AgentEntry = { agentId: string; name: string };

const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;

const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

// ── Style helpers ──────────────────────────────────────────────────────

function statusStyle(s: string) {
  switch (s) {
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
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function priorityStyle(p: string) {
  switch (p) {
    case "urgent":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "high":
      return "bg-orange-500/15 text-orange-400 border-orange-500/30";
    case "medium":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function Badge({ label, style }: { label: string; style?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        style ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editingMeta, setEditingMeta] = useState(false);

  // Comment compose
  const [commentBody, setCommentBody] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);

  const loadTask = useCallback(() => {
    if (!taskId) {
      return;
    }
    setLoading(true);
    Promise.all([
      sendRpc<Task>("tasks.get", { id: taskId }),
      sendRpc<{ comments: TaskComment[] }>("tasks.listComments", { taskId }),
      sendRpc<{ agents: AgentEntry[] }>("agents.list").catch(() => ({ agents: [] })),
    ])
      .then(([t, commentsRes, agentsRes]) => {
        setTask(t);
        setEditTitle(t.title);
        setEditDesc(t.description ?? "");
        setComments(commentsRes.comments ?? []);
        setAgents(agentsRes.agents ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [taskId, sendRpc]);

  useEffect(() => {
    if (isConnected) {
      loadTask();
    }
  }, [isConnected, loadTask]);

  const handleStatusChange = (status: string) => {
    if (!task) {
      return;
    }
    sendRpc<Task>("tasks.update", { id: task.id, status })
      .then((updated) => setTask(updated))
      .catch((err: unknown) => setError(String(err)));
  };

  const handlePriorityChange = (priority: string) => {
    if (!task) {
      return;
    }
    sendRpc<Task>("tasks.update", { id: task.id, priority })
      .then((updated) => setTask(updated))
      .catch((err: unknown) => setError(String(err)));
  };

  const handleAssigneeChange = (assigneeAgentId: string) => {
    if (!task) {
      return;
    }
    sendRpc<Task>("tasks.update", { id: task.id, assigneeAgentId: assigneeAgentId || null })
      .then((updated) => setTask(updated))
      .catch((err: unknown) => setError(String(err)));
  };

  const handleSaveMeta = () => {
    if (!task) {
      return;
    }
    sendRpc<Task>("tasks.update", {
      id: task.id,
      title: editTitle.trim() || task.title,
      description: editDesc || null,
    })
      .then((updated) => {
        setTask(updated);
        setEditingMeta(false);
      })
      .catch((err: unknown) => setError(String(err)));
  };

  const handleAddComment = () => {
    if (!task || !commentBody.trim()) {
      return;
    }
    setSubmittingComment(true);
    sendRpc<{ comment: TaskComment }>("tasks.addComment", {
      taskId: task.id,
      body: commentBody.trim(),
    })
      .then((res) => {
        setComments((prev) => [...prev, res.comment]);
        setCommentBody("");
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setSubmittingComment(false));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <AlertCircle className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{error ?? "Task not found."}</p>
        <Button variant="outline" size="sm" onClick={() => void navigate("/tasks")}>
          <ArrowLeft className="mr-1.5 size-3.5" /> Back to Tasks
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto">
      {/* Back nav */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => void navigate("/tasks")}>
          <ArrowLeft className="mr-1.5 size-3.5" /> Tasks
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-sm text-muted-foreground">{task.identifier}</span>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Title + description */}
      <div className="rounded-lg border bg-card p-5 flex flex-col gap-4">
        {editingMeta ? (
          <>
            <input
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-lg font-semibold outline-none focus:border-ring"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Task title"
            />
            <textarea
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:border-ring resize-none min-h-[80px]"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Description (optional)"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveMeta}>
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditingMeta(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <h1 className="text-xl font-semibold">{task.title}</h1>
              <Button size="sm" variant="ghost" onClick={() => setEditingMeta(true)}>
                Edit
              </Button>
            </div>
            {task.description ? (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {task.description}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic">No description.</p>
            )}
          </>
        )}
      </div>

      {/* Metadata panel */}
      <div className="rounded-lg border bg-card p-5 grid grid-cols-2 gap-5 text-sm">
        {/* Status */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Status
          </label>
          <div className="flex flex-wrap gap-1">
            {TASK_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => handleStatusChange(s)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity",
                  task.status === s ? statusStyle(s) : "opacity-40 hover:opacity-70",
                  task.status !== s && statusStyle(s),
                )}
              >
                {s.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </div>

        {/* Priority */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Priority
          </label>
          <div className="flex flex-wrap gap-1">
            {TASK_PRIORITIES.map((p) => (
              <button
                key={p}
                onClick={() => handlePriorityChange(p)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity",
                  task.priority === p ? priorityStyle(p) : "opacity-40 hover:opacity-70",
                  task.priority !== p && priorityStyle(p),
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Assignee */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Assignee
          </label>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
            value={task.assigneeAgentId ?? ""}
            onChange={(e) => handleAssigneeChange(e.target.value)}
          >
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {/* Timestamps */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Timestamps
          </label>
          <div className="text-xs text-muted-foreground">
            Created: {new Date(task.createdAt * 1000).toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">
            Updated: {new Date(task.updatedAt * 1000).toLocaleString()}
          </div>
          {task.completedAt && (
            <div className="text-xs text-green-400">
              Completed: {new Date(task.completedAt * 1000).toLocaleString()}
            </div>
          )}
        </div>

        {/* Current badges summary */}
        <div className="flex flex-col gap-2 col-span-2 border-t pt-4">
          <div className="flex items-center gap-2">
            <Badge label={task.status} style={statusStyle(task.status)} />
            <Badge label={task.priority} style={priorityStyle(task.priority)} />
            {task.billingCode && (
              <span className="font-mono text-xs text-muted-foreground">{task.billingCode}</span>
            )}
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="rounded-lg border bg-card p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="size-4 text-muted-foreground" />
            <h3 className="font-medium">
              Comments{" "}
              <span className="text-muted-foreground font-normal text-sm">({comments.length})</span>
            </h3>
          </div>
          <Button variant="ghost" size="sm" onClick={loadTask}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>

        {/* Comment list */}
        <div className="flex flex-col gap-3">
          {comments.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No comments yet.</p>
          ) : (
            comments.map((c) => (
              <div key={c.id} className="flex gap-3">
                <div className="shrink-0 mt-0.5">
                  {c.authorType === "agent" ? (
                    <Bot className="size-4 text-muted-foreground" />
                  ) : (
                    <User className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">
                      {c.authorType === "agent" ? c.authorId : "You"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(c.createdAt * 1000).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{c.body}</p>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Compose */}
        <div className="flex gap-2 mt-1 border-t pt-4">
          <textarea
            className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:border-ring resize-none min-h-[72px]"
            placeholder="Add a comment…"
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleAddComment();
              }
            }}
          />
          <Button
            size="sm"
            className="self-end"
            disabled={!commentBody.trim() || submittingComment}
            onClick={handleAddComment}
          >
            {submittingComment ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">⌘+Enter to submit</p>
      </div>
    </div>
  );
}
