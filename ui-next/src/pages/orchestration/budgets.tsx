import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  DollarSign,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ─────────────────────────────────────────────────────────────

type BudgetPolicy = {
  id: string;
  workspaceId: string;
  scopeType: "workspace" | "agent" | "project";
  scopeId: string;
  amountMicrocents: number;
  windowKind: "calendar_month_utc" | "lifetime";
  warnPercent: number;
  hardStop: number;
  createdAt: number;
  updatedAt: number;
};

type BudgetIncident = {
  id: string;
  workspaceId: string;
  policyId: string;
  type: "warning" | "hard_stop" | "resolved";
  agentId: string | null;
  spentMicrocents: number;
  limitMicrocents: number;
  message: string | null;
  resolvedAt: number | null;
  createdAt: number;
};

type CostEvent = {
  id: string;
  workspaceId: string;
  agentId: string;
  costMicrocents: number;
  inputTokens: number;
  outputTokens: number;
  occurredAt: number;
  model: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────

function microToUsd(microcents: number): string {
  return `$${(microcents / 100_000_000).toFixed(4)}`;
}

function incidentStyle(type: string): string {
  switch (type) {
    case "warning":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "hard_stop":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "resolved":
      return "bg-green-500/15 text-green-400 border-green-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function IncidentBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        incidentStyle(type),
      )}
    >
      {type === "warning" && <AlertTriangle className="size-3" />}
      {type === "hard_stop" && <Ban className="size-3" />}
      {type === "resolved" && <CheckCircle2 className="size-3" />}
      {type.replace("_", " ")}
    </span>
  );
}

// ── Create Policy Dialog ───────────────────────────────────────────────

function CreatePolicyDialog({
  open,
  onOpenChange,
  onCreated,
  sendRpc,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}) {
  const [workspaceId, setWorkspaceId] = useState("default");
  const [scopeType, setScopeType] = useState<"workspace" | "agent" | "project">("workspace");
  const [scopeId, setScopeId] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [warnPercent, setWarnPercent] = useState("80");
  const [hardStop, setHardStop] = useState("100");
  const [windowKind, setWindowKind] = useState<"calendar_month_utc" | "lifetime">(
    "calendar_month_utc",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For workspace scope, scopeId defaults to workspaceId
  const effectiveScopeId = scopeType === "workspace" ? workspaceId : scopeId;

  const resetForm = () => {
    setWorkspaceId("default");
    setScopeType("workspace");
    setScopeId("");
    setAmountUsd("");
    setWarnPercent("80");
    setHardStop("100");
    setWindowKind("calendar_month_utc");
    setError(null);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      resetForm();
    }
    onOpenChange(v);
  };

  const handleSubmit = () => {
    const usd = parseFloat(amountUsd);
    if (isNaN(usd) || usd <= 0) {
      setError("Amount must be a positive number");
      return;
    }
    if (!effectiveScopeId) {
      setError("Scope ID is required");
      return;
    }
    setSubmitting(true);
    sendRpc("budgets.policies.create", {
      workspaceId,
      scopeType,
      scopeId: effectiveScopeId,
      amountMicrocents: Math.round(usd * 100_000_000),
      windowKind,
      warnPercent: parseInt(warnPercent, 10) || 0,
      hardStop: parseInt(hardStop, 10) || 0,
    })
      .then(() => {
        onCreated();
        handleOpenChange(false);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setSubmitting(false));
  };

  const canSubmit = amountUsd.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Budget Policy</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Workspace ID</label>
            <Input
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="default"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Scope Type</label>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={scopeType}
              onChange={(e) => setScopeType(e.target.value as typeof scopeType)}
            >
              <option value="workspace">Workspace</option>
              <option value="agent">Agent</option>
              <option value="project">Project</option>
            </select>
          </div>

          {scopeType !== "workspace" && (
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">
                {scopeType === "agent" ? "Agent ID" : "Project ID"}
              </label>
              <Input
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                placeholder={scopeType === "agent" ? "agent-id" : "project-id"}
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Budget (USD) *</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amountUsd}
              onChange={(e) => setAmountUsd(e.target.value)}
              placeholder="10.00"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Window</label>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={windowKind}
              onChange={(e) => setWindowKind(e.target.value as typeof windowKind)}
            >
              <option value="calendar_month_utc">Monthly (UTC)</option>
              <option value="lifetime">Lifetime</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Warn at %</label>
              <Input
                type="number"
                min="0"
                max="100"
                value={warnPercent}
                onChange={(e) => setWarnPercent(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Hard stop at %</label>
              <Input
                type="number"
                min="0"
                max="100"
                value={hardStop}
                onChange={(e) => setHardStop(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function BudgetsPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [policies, setPolicies] = useState<BudgetPolicy[]>([]);
  const [incidents, setIncidents] = useState<BudgetIncident[]>([]);
  const [recentCosts, setRecentCosts] = useState<CostEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [incidentFilter, setIncidentFilter] = useState<"all" | "active" | "resolved">("active");

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      sendRpc<{ policies: BudgetPolicy[] }>("budgets.policies.list", {}),
      sendRpc<{ incidents: BudgetIncident[] }>("budgets.incidents.list", {}),
      sendRpc<{ events: CostEvent[] }>("costs.events.list", {}),
    ])
      .then(([polRes, incRes, costRes]) => {
        setPolicies(polRes.policies ?? []);
        setIncidents(incRes.incidents ?? []);
        setRecentCosts(costRes.events ?? []);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sendRpc]);

  useEffect(() => {
    if (isConnected) {
      loadData();
    }
  }, [isConnected, loadData]);

  const handleDeletePolicy = (id: string) => {
    sendRpc("budgets.policies.delete", { id })
      .then(() => setPolicies((prev) => prev.filter((p) => p.id !== id)))
      .catch((err: unknown) => setError(String(err)));
  };

  const handleResolveIncident = (id: string) => {
    sendRpc("budgets.incidents.resolve", { id })
      .then(() =>
        setIncidents((prev) =>
          prev.map((inc) =>
            inc.id === id ? { ...inc, type: "resolved", resolvedAt: Date.now() / 1000 } : inc,
          ),
        ),
      )
      .catch((err: unknown) => setError(String(err)));
  };

  // Aggregate spend stats
  const totalSpendMicrocents = recentCosts.reduce((sum, e) => sum + e.costMicrocents, 0);
  const activeIncidents = incidents.filter((i) => i.type !== "resolved");
  const hardStops = activeIncidents.filter((i) => i.type === "hard_stop");

  const filteredIncidents = incidents.filter((i) => {
    if (incidentFilter === "active") {
      return i.type !== "resolved";
    }
    if (incidentFilter === "resolved") {
      return i.type === "resolved";
    }
    return true;
  });

  const policyColumns: Column<BudgetPolicy>[] = [
    {
      key: "scopeType",
      header: "Scope",
      sortable: true,
      render: (row) => (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground border-border">
          {row.scopeType}
        </span>
      ),
    },
    {
      key: "scopeId",
      header: "Scope ID",
      render: (row) => (
        <span className="font-mono text-xs text-muted-foreground" title={row.scopeId}>
          {row.scopeId.slice(0, 20)}
          {row.scopeId.length > 20 ? "…" : ""}
        </span>
      ),
    },
    {
      key: "amountMicrocents",
      header: "Limit",
      sortable: true,
      render: (row) => <span className="font-medium">{microToUsd(row.amountMicrocents)}</span>,
    },
    {
      key: "windowKind",
      header: "Window",
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {row.windowKind === "calendar_month_utc" ? "Monthly" : "Lifetime"}
        </span>
      ),
    },
    {
      key: "warnPercent",
      header: "Warn / Stop",
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {row.warnPercent}% / {row.hardStop > 0 ? `${row.hardStop}%` : "—"}
        </span>
      ),
    },
    {
      key: "id",
      header: "",
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400"
          onClick={(e) => {
            e.stopPropagation();
            handleDeletePolicy(row.id);
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ),
    },
  ];

  const incidentColumns: Column<BudgetIncident>[] = [
    {
      key: "type",
      header: "Type",
      sortable: true,
      render: (row) => <IncidentBadge type={row.type} />,
    },
    {
      key: "message",
      header: "Message",
      render: (row) => <span className="text-sm text-muted-foreground">{row.message ?? "—"}</span>,
    },
    {
      key: "spentMicrocents",
      header: "Spent",
      sortable: true,
      render: (row) => <span className="font-medium">{microToUsd(row.spentMicrocents)}</span>,
    },
    {
      key: "limitMicrocents",
      header: "Limit",
      sortable: true,
      render: (row) => (
        <span className="text-muted-foreground">{microToUsd(row.limitMicrocents)}</span>
      ),
    },
    {
      key: "createdAt",
      header: "Triggered",
      sortable: true,
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.createdAt * 1000).toLocaleString()}
        </span>
      ),
    },
    {
      key: "resolvedAt",
      header: "",
      render: (row) =>
        row.type !== "resolved" ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-green-400"
            onClick={(e) => {
              e.stopPropagation();
              handleResolveIncident(row.id);
            }}
          >
            Resolve
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <DollarSign className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Budgets</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1 size-3.5" />
            Create Budget
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border bg-card p-4 flex flex-col gap-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Total Spend</span>
          <span className="text-xl font-semibold">{microToUsd(totalSpendMicrocents)}</span>
          <span className="text-xs text-muted-foreground">{recentCosts.length} events</span>
        </div>
        <div className="rounded-lg border bg-card p-4 flex flex-col gap-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">
            Active Incidents
          </span>
          <span
            className={cn(
              "text-xl font-semibold",
              activeIncidents.length > 0 ? "text-amber-400" : "text-green-400",
            )}
          >
            {activeIncidents.length}
          </span>
          <span className="text-xs text-muted-foreground">{policies.length} policies</span>
        </div>
        <div className="rounded-lg border bg-card p-4 flex flex-col gap-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Hard Stops</span>
          <span
            className={cn(
              "text-xl font-semibold",
              hardStops.length > 0 ? "text-red-400" : "text-muted-foreground",
            )}
          >
            {hardStops.length}
          </span>
          <span className="text-xs text-muted-foreground">agents blocked</span>
        </div>
      </div>

      {/* Budget Policies */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">
            Policies{" "}
            <span className="text-muted-foreground font-normal text-sm">({policies.length})</span>
          </h3>
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1 size-3.5" /> New Policy
          </Button>
        </div>
        {loading && policies.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <DataTable<BudgetPolicy>
            columns={policyColumns}
            data={policies}
            keyField="id"
            emptyMessage="No budget policies configured."
            pageSize={10}
            compact
          />
        )}
      </div>

      {/* Incidents */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">
            Incidents{" "}
            <span className="text-muted-foreground font-normal text-sm">
              ({filteredIncidents.length})
            </span>
          </h3>
          <div className="flex gap-1">
            {(["active", "all", "resolved"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={incidentFilter === f ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setIncidentFilter(f)}
              >
                {f}
              </Button>
            ))}
          </div>
        </div>
        <DataTable<BudgetIncident>
          columns={incidentColumns}
          data={filteredIncidents}
          keyField="id"
          emptyMessage="No incidents."
          pageSize={10}
          compact
        />
      </div>

      <CreatePolicyDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        sendRpc={sendRpc as <T>(method: string, params?: Record<string, unknown>) => Promise<T>}
        onCreated={loadData}
      />
    </div>
  );
}
