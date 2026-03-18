import { Bell, RefreshCw, Loader2, Check, X } from "lucide-react";
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

type Approval = {
  id: string;
  workspaceId: string;
  type: string;
  status: string;
  requesterId: string;
  requesterType: string;
  payloadJson: string;
  decisionNote: string;
  decidedBy: string;
  decidedAt: number;
  createdAt: number;
  updatedAt: number;
};

type ApprovalStatus = "pending" | "approved" | "rejected" | "revision_requested";

const STATUS_FILTERS: ApprovalStatus[] = ["pending", "approved", "rejected", "revision_requested"];

// ── Helpers ───────────────────────────────────────────────────────────

function statusStyle(status: string): string {
  switch (status) {
    case "pending":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "approved":
      return "bg-green-500/15 text-green-400 border-green-500/30";
    case "rejected":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "revision_requested":
      return "bg-orange-500/15 text-orange-400 border-orange-500/30";
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
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

// ── Detail Dialog ─────────────────────────────────────────────────────

function ApprovalDetailDialog({
  approval,
  onClose,
}: {
  approval: Approval | null;
  onClose: () => void;
}) {
  if (!approval) {
    return null;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(approval.payloadJson);
  } catch {
    parsed = approval.payloadJson;
  }

  return (
    <Dialog
      open={approval !== null}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Approval: <span className="font-mono text-sm">{approval.type}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2 text-sm">
          <div className="flex gap-3 flex-wrap">
            <StatusBadge status={approval.status} />
          </div>
          <div>
            <span className="text-muted-foreground">Requester:</span>{" "}
            <span className="font-mono text-xs">
              {approval.requesterType}:{approval.requesterId}
            </span>
          </div>
          {approval.decidedBy && (
            <div>
              <span className="text-muted-foreground">Decided by:</span>{" "}
              <span className="font-mono text-xs">{approval.decidedBy}</span>
            </div>
          )}
          {approval.decisionNote && (
            <div>
              <span className="text-muted-foreground">Note:</span>{" "}
              <span>{approval.decisionNote}</span>
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">Payload</label>
            <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs max-h-48 font-mono">
              {JSON.stringify(parsed, null, 2)}
            </pre>
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

export function ApprovalsPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailApproval, setDetailApproval] = useState<Approval | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, string> = {};
    if (statusFilter !== "all") {
      params.status = statusFilter;
    }

    sendRpc<{ approvals: Approval[] }>("approvals.list", params)
      .then((res) => setApprovals(res.approvals ?? []))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sendRpc, statusFilter]);

  useEffect(() => {
    if (isConnected) {
      loadData();
    }
  }, [isConnected, loadData]);

  const handleDecide = (id: string, decision: "approved" | "rejected") => {
    setActionLoading(id);
    sendRpc("approvals.decide", { id, decision, decidedBy: "operator" })
      .then(() => loadData())
      .catch((err) => setError(String(err)))
      .finally(() => setActionLoading(null));
  };

  const columns: Column<Approval>[] = [
    {
      key: "type",
      header: "Type",
      sortable: true,
      render: (row) => <span className="font-mono text-xs">{row.type}</span>,
    },
    {
      key: "requesterId",
      header: "Requester",
      render: (row) => (
        <span className="font-mono text-xs text-muted-foreground" title={row.requesterId}>
          {row.requesterType}:{row.requesterId.slice(0, 10)}…
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.createdAt * 1000).toLocaleString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => {
        if (row.status !== "pending") {
          return null;
        }
        const busy = actionLoading === row.id;
        return (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs bg-green-600 hover:bg-green-700"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                handleDecide(row.id, "approved");
              }}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 gap-1 px-2 text-xs"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                handleDecide(row.id, "rejected");
              }}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
              Reject
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bell className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Approvals</h2>
          <span className="text-sm text-muted-foreground">({approvals.length})</span>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Status filter */}
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

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && approvals.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DataTable<Approval>
          columns={columns}
          data={approvals}
          keyField="id"
          emptyMessage="No approvals found."
          pageSize={25}
          compact
          onRowClick={(row) => setDetailApproval(row)}
        />
      )}

      <ApprovalDetailDialog approval={detailApproval} onClose={() => setDetailApproval(null)} />
    </div>
  );
}
