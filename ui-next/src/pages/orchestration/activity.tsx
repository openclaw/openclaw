import { ScrollText, RefreshCw, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ─────────────────────────────────────────────────────────────

type ActivityLogEntry = {
  id: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  detailsJson: string;
  createdAt: number;
};

type Workspace = { id: string; name: string };

// ── Helpers ───────────────────────────────────────────────────────────

function actionColor(action: string): string {
  if (action.includes("create") || action.includes("add")) {
    return "text-green-400";
  }
  if (action.includes("delete") || action.includes("remove") || action.includes("reject")) {
    return "text-red-400";
  }
  if (action.includes("update") || action.includes("edit")) {
    return "text-blue-400";
  }
  if (action.includes("approve")) {
    return "text-green-400";
  }
  return "text-muted-foreground";
}

// ── Main Page ──────────────────────────────────────────────────────────

export function ActivityPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, unknown> = { limit: 100 };
    if (workspaceFilter !== "all") {
      params.workspaceId = workspaceFilter;
    }

    Promise.all([
      sendRpc<{ entries: ActivityLogEntry[] }>("activityLogs.list", params),
      sendRpc<{ workspaces: Workspace[] }>("workspaces.list"),
    ])
      .then(([actRes, wsRes]) => {
        setEntries(actRes.entries ?? []);
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Activity</h2>
          <span className="text-sm text-muted-foreground">({entries.length})</span>
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

      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          <ScrollText className="mx-auto mb-3 size-8 opacity-30" />
          <p className="text-sm">No activity yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border/50">
            {entries.map((entry) => {
              const d = new Date(entry.createdAt * 1000);
              const dateStr = d.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });
              const timeStr = d.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              });

              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 px-4 py-2.5 text-xs hover:bg-muted/20"
                >
                  {/* Timestamp */}
                  <div className="shrink-0 text-muted-foreground w-28 pt-px">
                    <div>{dateStr}</div>
                    <div className="font-mono">{timeStr}</div>
                  </div>

                  {/* Actor */}
                  <span
                    className="shrink-0 inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground max-w-[120px] truncate"
                    title={`${entry.actorType}:${entry.actorId}`}
                  >
                    {entry.actorType}:{entry.actorId.slice(0, 8)}
                  </span>

                  {/* Action */}
                  <span className={cn("shrink-0 font-mono font-medium", actionColor(entry.action))}>
                    {entry.action}
                  </span>

                  {/* Entity */}
                  {(entry.entityType || entry.entityId) && (
                    <span
                      className="text-muted-foreground truncate"
                      title={`${entry.entityType}:${entry.entityId}`}
                    >
                      {entry.entityType}
                      {entry.entityId ? `:${entry.entityId.slice(0, 10)}` : ""}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
