import { Target, RefreshCw, Loader2 } from "lucide-react";
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

type Goal = {
  id: string;
  workspaceId: string;
  parentId: string;
  title: string;
  description: string;
  level: string;
  status: string;
  ownerAgentId: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
};

type Workspace = { id: string; name: string };

// ── Helpers ───────────────────────────────────────────────────────────

function statusStyle(status: string): string {
  switch (status) {
    case "planned":
      return "bg-muted text-muted-foreground border-border";
    case "in_progress":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "achieved":
      return "bg-green-500/15 text-green-400 border-green-500/30";
    case "abandoned":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function levelStyle(level: string): string {
  switch (level) {
    case "objective":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "key_result":
      return "bg-purple-500/15 text-purple-400 border-purple-500/30";
    case "milestone":
      return "bg-green-500/15 text-green-400 border-green-500/30";
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
        status === "abandoned" && "line-through opacity-70",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        levelStyle(level),
      )}
    >
      {level.replace("_", " ")}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}

const ALL_STATUSES = ["planned", "in_progress", "achieved", "abandoned"];

// ── Detail Dialog ─────────────────────────────────────────────────────

function GoalDetailDialog({
  goal,
  onClose,
  onUpdate,
}: {
  goal: Goal | null;
  onClose: () => void;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
}) {
  const [progressDraft, setProgressDraft] = useState("");

  useEffect(() => {
    if (goal) {
      setProgressDraft(String(goal.progress ?? 0));
    }
  }, [goal]);

  if (!goal) {
    return null;
  }

  return (
    <Dialog
      open={goal !== null}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{goal.title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2 text-sm">
          <div className="flex gap-3 flex-wrap">
            <LevelBadge level={goal.level} />
            <StatusBadge status={goal.status} />
          </div>
          {goal.description && <p className="text-muted-foreground">{goal.description}</p>}
          {goal.ownerAgentId && (
            <div>
              <span className="text-muted-foreground">Owner:</span>{" "}
              <span className="font-mono text-xs">{goal.ownerAgentId}</span>
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">
              Update Status
            </label>
            <div className="flex flex-wrap gap-1">
              {ALL_STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={goal.status === s ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={() => onUpdate(goal.id, { status: s })}
                >
                  {s.replace("_", " ")}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-muted-foreground">Progress (0-100):</label>
            <input
              type="number"
              min={0}
              max={100}
              value={progressDraft}
              onChange={(e) => setProgressDraft(e.target.value)}
              className="h-7 w-20 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
            />
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onUpdate(goal.id, { progress: Number(progressDraft) })}
            >
              Save
            </Button>
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

export function GoalsPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [goals, setGoals] = useState<Goal[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [detailGoal, setDetailGoal] = useState<Goal | null>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, string> = {};
    if (workspaceFilter !== "all") {
      params.workspaceId = workspaceFilter;
    }

    Promise.all([
      sendRpc<{ goals: Goal[] }>("goals.list", params),
      sendRpc<{ workspaces: Workspace[] }>("workspaces.list"),
    ])
      .then(([goalsRes, wsRes]) => {
        setGoals(goalsRes.goals ?? []);
        setWorkspaces(wsRes.workspaces ?? []);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sendRpc, workspaceFilter]);

  useEffect(() => {
    if (isConnected) {
      loadData();
    }
  }, [isConnected, loadData]);

  const handleUpdate = (id: string, patch: Record<string, unknown>) => {
    sendRpc("goals.update", { id, ...patch })
      .then(() => {
        setDetailGoal((prev) =>
          prev?.id === id ? { ...prev, ...(patch as Partial<Goal>) } : prev,
        );
        loadData();
      })
      .catch((err) => setError(String(err)));
  };

  // Build a map for parent title lookup
  const goalsById = Object.fromEntries(goals.map((g) => [g.id, g]));

  const columns: Column<Goal>[] = [
    {
      key: "title",
      header: "Title",
      sortable: true,
      render: (row) => {
        const indent = row.level === "key_result" ? 2 : row.level === "milestone" ? 4 : 0;
        return (
          <div style={{ paddingLeft: `${indent * 8}px` }} className="min-w-0">
            <div className="truncate font-medium">{row.title}</div>
            {row.parentId && goalsById[row.parentId] && (
              <div className="truncate text-xs text-muted-foreground">
                {goalsById[row.parentId].title}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "level",
      header: "Level",
      sortable: true,
      render: (row) => <LevelBadge level={row.level} />,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "progress",
      header: "Progress",
      sortable: true,
      render: (row) => <ProgressBar value={row.progress} />,
    },
    {
      key: "ownerAgentId",
      header: "Owner",
      render: (row) =>
        row.ownerAgentId ? (
          <span className="font-mono text-xs text-muted-foreground" title={row.ownerAgentId}>
            {row.ownerAgentId.slice(0, 12)}…
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Goals</h2>
          <span className="text-sm text-muted-foreground">({goals.length})</span>
        </div>
        <div className="flex items-center gap-2">
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
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && goals.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DataTable<Goal>
          columns={columns}
          data={goals}
          keyField="id"
          emptyMessage="No goals found."
          pageSize={25}
          compact
          onRowClick={(row) => setDetailGoal(row)}
        />
      )}

      <GoalDetailDialog
        goal={detailGoal}
        onClose={() => setDetailGoal(null)}
        onUpdate={handleUpdate}
      />
    </div>
  );
}
