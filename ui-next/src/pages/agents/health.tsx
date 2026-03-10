import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Loader2,
  Settings,
  Wand2,
  Sparkles,
  X,
  RotateCcw,
  LayoutGrid,
  List,
  Upload,
  HardDrive,
  ArrowUpCircle,
} from "lucide-react";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────────────

interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
  fixType?: string;
}

interface AgentHealth {
  id: string;
  name?: string;
  version: string;
  tier: number;
  scope: string;
  checks: HealthCheck[];
  status: "healthy" | "degraded" | "error";
}

interface DeployStatusEntry {
  agentId: string;
  deployed: boolean;
  currentVersion: string | null;
  manifestVersion: string;
  needsUpgrade: boolean;
  workspaceExists: boolean;
}

type FixState = "idle" | "loading" | "success" | "error";

// ── Status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: AgentHealth["status"] }) {
  switch (status) {
    case "healthy":
      return <CheckCircle2 className="size-5 text-green-600" />;
    case "degraded":
      return <AlertTriangle className="size-5 text-amber-500" />;
    case "error":
      return <XCircle className="size-5 text-destructive" />;
  }
}

// ── Preview dialog ───────────────────────────────────────────────────────────

function FixPreviewDialog({
  open,
  agentId,
  fixType,
  content,
  onApply,
  onRegenerate,
  onClose,
  applying,
  regenerating,
}: {
  open: boolean;
  agentId: string;
  fixType: string;
  content: string;
  onApply: () => void;
  onRegenerate: () => void;
  onClose: () => void;
  applying: boolean;
  regenerating: boolean;
}) {
  const fixInfo = (() => {
    switch (fixType) {
      case "missing-prompt":
        return {
          title: "Generated AGENT.md",
          description:
            "This agent is missing its prompt file (AGENT.md). A new prompt has been generated from the agent manifest — including role description, responsibilities, hierarchy context, and communication guidelines.",
          file: "AGENT.md",
        };
      case "short-prompt":
        return {
          title: "Extended AGENT.md",
          description:
            "The existing prompt file is too short or missing key sections (role description, responsibilities). An expanded version has been generated while preserving existing content.",
          file: "AGENT.md",
        };
      case "invalid-manifest":
        return {
          title: "Corrected agent.yaml",
          description:
            "The agent manifest has schema validation errors (missing required fields or invalid values). The corrected version below fills in defaults for missing fields while preserving all existing configuration.",
          file: "agent.yaml",
        };
      default:
        return { title: "Fix Preview", description: "", file: "" };
    }
  })();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-500" />
            {fixInfo.title} — {agentId}
          </DialogTitle>
        </DialogHeader>
        {fixInfo.description && (
          <p className="text-sm text-muted-foreground -mt-1">{fixInfo.description}</p>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{fixInfo.file}</span>
          <span>will be written to the agent directory</span>
          <span className="ml-auto opacity-60">raw markdown source</span>
        </div>
        <div className="flex-1 overflow-auto rounded-md border bg-muted/50 p-4">
          <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed">{content}</pre>
        </div>
        <DialogFooter className="flex items-center gap-2 sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={onRegenerate}
            disabled={regenerating || applying}
          >
            {regenerating ? (
              <Loader2 className="size-3.5 animate-spin mr-1" />
            ) : (
              <RotateCcw className="size-3.5 mr-1" />
            )}
            Regenerate
          </Button>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" onClick={onApply} disabled={applying}>
              {applying ? (
                <Loader2 className="size-3.5 animate-spin mr-1" />
              ) : (
                <CheckCircle2 className="size-3.5 mr-1" />
              )}
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Health card ──────────────────────────────────────────────────────────────

function HealthCard({
  agent,
  deployStatus,
  onConfigure,
  onFix,
  onDeploy,
  fixStates,
  fixingAgent,
}: {
  agent: AgentHealth;
  deployStatus?: DeployStatusEntry;
  onConfigure: (id: string) => void;
  onFix: (agentId: string, fixType: string) => void;
  onDeploy: (agentId: string) => void;
  fixStates: Map<string, FixState>;
  fixingAgent: string | null;
}) {
  const isFixing = fixingAgent === agent.id;
  const deployFixKey = `${agent.id}:deploy-workspace`;
  const deployState = fixStates.get(deployFixKey) ?? "idle";

  return (
    <div
      className={cn(
        "rounded-lg border p-4 space-y-3",
        agent.status === "error" && "border-destructive/30",
        agent.status === "degraded" && "border-amber-500/30",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusIcon status={agent.status} />
          <div>
            <h3 className="font-semibold">{agent.name ?? agent.id}</h3>
            <span className="text-xs text-muted-foreground">
              v{agent.version} | Tier {agent.tier} | {agent.scope}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "text-xs font-medium px-2 py-0.5 rounded-full",
              agent.status === "healthy" && "bg-green-500/10 text-green-600",
              agent.status === "degraded" && "bg-amber-500/10 text-amber-600",
              agent.status === "error" && "bg-destructive/10 text-destructive",
            )}
          >
            {agent.status}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => onConfigure(agent.id)}
            title="Configure agent"
          >
            <Settings className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Deploy status */}
      {deployStatus && (
        <div className="flex items-center gap-2 text-xs border-t pt-2">
          {deployStatus.deployed ? (
            <>
              <HardDrive className="size-3.5 text-green-600 shrink-0" />
              <span className="text-muted-foreground">
                Workspace v{deployStatus.currentVersion}
              </span>
              {deployStatus.needsUpgrade && (
                <>
                  <ArrowUpCircle className="size-3.5 text-amber-500 shrink-0" />
                  <span className="text-amber-600">
                    upgrade available (v{deployStatus.manifestVersion})
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-xs text-amber-600 hover:bg-amber-500/10 ml-auto"
                    onClick={() => {
                      onDeploy(agent.id);
                    }}
                    disabled={deployState === "loading" || isFixing}
                  >
                    {deployState === "loading" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Upload className="size-3" />
                    )}
                    <span className="ml-1">Upgrade</span>
                  </Button>
                </>
              )}
            </>
          ) : (
            <>
              <XCircle className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Workspace not deployed</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs text-blue-600 hover:bg-blue-500/10 ml-auto"
                onClick={() => onDeploy(agent.id)}
                disabled={deployState === "loading" || isFixing}
              >
                {deployState === "loading" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Upload className="size-3" />
                )}
                <span className="ml-1">Deploy</span>
              </Button>
            </>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        {agent.checks.map((check, i) => {
          const fixKey = `${agent.id}:${check.fixType}`;
          const state = fixStates.get(fixKey) ?? "idle";

          return (
            <div key={i} className="flex items-center gap-2 text-sm">
              {state === "success" ? (
                <CheckCircle2 className="size-3.5 text-green-600 shrink-0 animate-in fade-in" />
              ) : check.ok ? (
                <CheckCircle2 className="size-3.5 text-green-600 shrink-0" />
              ) : (
                <XCircle className="size-3.5 text-destructive shrink-0" />
              )}
              <span
                className={cn("flex-1", !check.ok && state !== "success" && "text-destructive")}
              >
                {check.name}
                {check.detail && (
                  <span className="text-muted-foreground ml-1">({check.detail})</span>
                )}
              </span>
              {!check.ok && check.fixType && state !== "success" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                  onClick={() => {
                    onFix(agent.id, check.fixType!);
                  }}
                  disabled={state === "loading" || isFixing}
                  title={`Fix: ${check.fixType}`}
                >
                  {state === "loading" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : state === "error" ? (
                    <XCircle className="size-3 text-destructive" />
                  ) : (
                    <Wand2 className="size-3" />
                  )}
                  <span className="ml-1">Fix</span>
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Toast notification ───────────────────────────────────────────────────────

function Toast({
  message,
  type,
  onClose,
}: {
  message: string;
  type: "success" | "error";
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg animate-in slide-in-from-bottom-4",
        type === "success"
          ? "bg-green-500/10 border-green-500/30 text-green-600"
          : "bg-destructive/10 border-destructive/30 text-destructive",
      )}
    >
      {type === "success" ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
      <span className="text-sm">{message}</span>
      <button onClick={onClose} className="ml-2 rounded p-0.5 hover:bg-black/10">
        <X className="size-3" />
      </button>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentHealthPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const navigate = useNavigate();

  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fix states: Map<"agentId:fixType", FixState>
  const [fixStates, setFixStates] = useState<Map<string, FixState>>(new Map());
  const [fixingAgent, setFixingAgent] = useState<string | null>(null);
  const [fixingAll, setFixingAll] = useState(false);

  // Preview dialog
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewContent, setPreviewContent] = useState("");
  const [previewAgentId, setPreviewAgentId] = useState("");
  const [previewFixType, setPreviewFixType] = useState("");
  const [applying, setApplying] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Config sync
  const [configSyncIssues, setConfigSyncIssues] = useState<
    { agentId: string; check: string; status: string; message: string; fixType?: string }[]
  >([]);
  const [syncing, setSyncing] = useState(false);

  // Deploy status
  const [deployStatuses, setDeployStatuses] = useState<DeployStatusEntry[]>([]);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // View mode
  type ViewMode = "grid" | "table";
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem("health-view-mode") as ViewMode) || "grid";
    } catch {
      return "grid";
    }
  });
  const toggleView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem("health-view-mode", mode);
    } catch {}
  }, []);

  const fetchHealth = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    setLoading(true);
    try {
      const res = await sendRpc("agents.marketplace.health", {});
      if (res && Array.isArray(res.agents)) {
        setAgents(res.agents as AgentHealth[]);
      }
      if (res && Array.isArray(res.configSyncIssues)) {
        setConfigSyncIssues(res.configSyncIssues);
      } else {
        setConfigSyncIssues([]);
      }
      if (res && Array.isArray(res.deployStatus)) {
        setDeployStatuses(res.deployStatus as DeployStatusEntry[]);
      } else {
        setDeployStatuses([]);
      }
    } catch {
      setAgents([]);
      setConfigSyncIssues([]);
      setDeployStatuses([]);
    } finally {
      setLoading(false);
    }
  }, [isConnected, sendRpc]);

  useEffect(() => {
    void fetchHealth();
  }, [fetchHealth]);

  // Auto-refresh every 30s when enabled
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchHealth, 30_000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, fetchHealth]);

  const handleConfigure = useCallback(
    (agentId: string) => navigate(`/agents/config/${agentId}`),
    [navigate],
  );

  const setFixState = useCallback((agentId: string, fixType: string, state: FixState) => {
    setFixStates((prev) => {
      const next = new Map(prev);
      next.set(`${agentId}:${fixType}`, state);
      return next;
    });
  }, []);

  // Types that show a preview dialog before applying
  const previewableFixTypes = new Set(["missing-prompt", "short-prompt", "invalid-manifest"]);

  const handleFix = useCallback(
    async (agentId: string, fixType: string) => {
      // For content-generating fixes, show preview first
      if (previewableFixTypes.has(fixType)) {
        setFixState(agentId, fixType, "loading");
        setFixingAgent(agentId);
        try {
          const res = await sendRpc("agents.marketplace.health.fix", {
            agentId,
            fixType,
            preview: true,
          });
          if (res?.success && res.preview) {
            setPreviewContent(res.preview as string);
            setPreviewAgentId(agentId);
            setPreviewFixType(fixType);
            setPreviewOpen(true);
            setFixState(agentId, fixType, "idle");
          } else {
            setFixState(agentId, fixType, "error");
            setToast({ message: `Preview failed for ${agentId}`, type: "error" });
          }
        } catch {
          setFixState(agentId, fixType, "error");
          setToast({ message: `Fix failed for ${agentId}`, type: "error" });
        } finally {
          setFixingAgent(null);
        }
        return;
      }

      // Direct fixes (enable-parent, missing-dependency, deprecated-replace)
      setFixState(agentId, fixType, "loading");
      setFixingAgent(agentId);
      try {
        const res = await sendRpc("agents.marketplace.health.fix", { agentId, fixType });
        if (res?.success) {
          setFixState(agentId, fixType, "success");
          setToast({ message: `Fixed: ${fixType} for ${agentId}`, type: "success" });
          setTimeout(() => fetchHealth(), 1000);
        } else {
          setFixState(agentId, fixType, "error");
          setToast({ message: res?.error ?? `Fix failed for ${agentId}`, type: "error" });
        }
      } catch (err) {
        setFixState(agentId, fixType, "error");
        setToast({ message: `Fix failed: ${(err as Error).message}`, type: "error" });
      } finally {
        setFixingAgent(null);
      }
    },
    [sendRpc, fetchHealth, setFixState],
  );

  const handleApplyPreview = useCallback(async () => {
    setApplying(true);
    try {
      const res = await sendRpc("agents.marketplace.health.fix", {
        agentId: previewAgentId,
        fixType: previewFixType,
      });
      if (res?.success) {
        setFixState(previewAgentId, previewFixType, "success");
        setToast({ message: `Applied: ${previewFixType} for ${previewAgentId}`, type: "success" });
        setPreviewOpen(false);
        setTimeout(() => fetchHealth(), 1000);
      } else {
        setToast({ message: res?.error ?? "Apply failed", type: "error" });
      }
    } catch (err) {
      setToast({ message: `Apply failed: ${(err as Error).message}`, type: "error" });
    } finally {
      setApplying(false);
    }
  }, [sendRpc, previewAgentId, previewFixType, fetchHealth, setFixState]);

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      const res = await sendRpc("agents.marketplace.health.fix", {
        agentId: previewAgentId,
        fixType: previewFixType,
        preview: true,
      });
      if (res?.success && res.preview) {
        setPreviewContent(res.preview as string);
      }
    } catch {
      setToast({ message: "Regenerate failed", type: "error" });
    } finally {
      setRegenerating(false);
    }
  }, [sendRpc, previewAgentId, previewFixType]);

  const handleFixAllIssues = useCallback(async () => {
    setFixingAll(true);
    const unhealthyAgents = agents.filter((a) => a.status !== "healthy");
    for (const agent of unhealthyAgents) {
      const fixable = agent.checks.filter(
        (c) => !c.ok && c.fixType && !previewableFixTypes.has(c.fixType),
      );
      for (const check of fixable) {
        await handleFix(agent.id, check.fixType!);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    setFixingAll(false);
    setTimeout(() => fetchHealth(), 1000);
  }, [agents, handleFix, fetchHealth]);

  const handleDeploy = useCallback(
    async (agentId: string) => {
      const _fixKey = `${agentId}:deploy-workspace`;
      setFixState(agentId, "deploy-workspace", "loading");
      setFixingAgent(agentId);
      try {
        const res = await sendRpc("agents.marketplace.health.fix", {
          agentId,
          fixType: "deploy-workspace",
        });
        if (res?.success) {
          setFixState(agentId, "deploy-workspace", "success");
          setToast({
            message: `Deployed workspace for ${agentId} (${res.filesWritten?.length ?? 0} files)`,
            type: "success",
          });
          setTimeout(() => fetchHealth(), 1000);
        } else {
          setFixState(agentId, "deploy-workspace", "error");
          setToast({ message: res?.error ?? `Deploy failed for ${agentId}`, type: "error" });
        }
      } catch (err) {
        setFixState(agentId, "deploy-workspace", "error");
        setToast({ message: `Deploy failed: ${(err as Error).message}`, type: "error" });
      } finally {
        setFixingAgent(null);
      }
    },
    [sendRpc, fetchHealth, setFixState],
  );

  const handleSyncAll = useCallback(async () => {
    setSyncing(true);
    try {
      // Use operator1 as the agentId for sync-all (it applies globally)
      const res = await sendRpc("agents.marketplace.health.fix", {
        agentId: "operator1",
        fixType: "sync-all",
      });
      if (res?.success && res.applied) {
        setToast({ message: `Config synced: ${res.detail ?? "done"}`, type: "success" });
        setTimeout(() => fetchHealth(), 1000);
      } else {
        setToast({ message: res?.detail ?? "No sync needed", type: "success" });
      }
    } catch (err) {
      setToast({ message: `Sync failed: ${(err as Error).message}`, type: "error" });
    } finally {
      setSyncing(false);
    }
  }, [sendRpc, fetchHealth]);

  const healthy = agents.filter((a) => a.status === "healthy");
  const unhealthy = agents.filter((a) => a.status !== "healthy");
  const totalFixable = unhealthy.reduce(
    (acc, a) => acc + a.checks.filter((c) => !c.ok && c.fixType).length,
    0,
  );

  const tableColumns = useMemo<Column<AgentHealth>[]>(
    () => [
      {
        key: "id",
        header: "Agent",
        sortable: true,
        render: (row) => (
          <div className="flex items-center gap-2">
            <StatusIcon status={row.status} />
            <span className="font-semibold">{row.name ?? row.id}</span>
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        sortable: true,
        render: (row) => (
          <span
            className={cn(
              "text-xs font-medium px-2 py-0.5 rounded-full",
              row.status === "healthy" && "bg-green-500/10 text-green-600",
              row.status === "degraded" && "bg-amber-500/10 text-amber-600",
              row.status === "error" && "bg-destructive/10 text-destructive",
            )}
          >
            {row.status}
          </span>
        ),
      },
      { key: "tier", header: "Tier", sortable: true, render: (row) => <span>T{row.tier}</span> },
      {
        key: "version",
        header: "Version",
        render: (row) => <span className="text-xs text-muted-foreground">v{row.version}</span>,
      },
      {
        key: "checks" as keyof AgentHealth,
        header: "Checks",
        render: (row) => {
          const passed = row.checks.filter((c) => c.ok).length;
          const total = row.checks.length;
          return (
            <span className={cn("text-xs", passed === total ? "text-green-600" : "text-amber-600")}>
              {passed}/{total} passed
            </span>
          );
        },
      },
      {
        key: "_issues" as keyof AgentHealth,
        header: "Issues",
        render: (row) => {
          const failed = row.checks.filter((c) => !c.ok);
          if (failed.length === 0) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {failed.map((c, i) => (
                <span key={i} className="text-xs text-destructive">
                  {c.name}
                  {c.detail ? ` (${c.detail})` : ""}
                  {i < failed.length - 1 && ","}
                </span>
              ))}
            </div>
          );
        },
      },
      {
        key: "_actions" as keyof AgentHealth,
        header: "Actions",
        render: (row) => {
          const fixable = row.checks.filter((c) => !c.ok && c.fixType);
          return (
            <div className="flex items-center gap-1">
              {fixable.map((c) => (
                <Button
                  key={c.fixType}
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-amber-600 hover:bg-amber-500/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleFix(row.id, c.fixType!);
                  }}
                  disabled={!!fixingAgent}
                  title={`Fix: ${c.fixType}`}
                >
                  <Wand2 className="size-3 mr-0.5" />
                  {c.fixType}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleConfigure(row.id);
                }}
                title="Configure"
              >
                <Settings className="size-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    [handleFix, handleConfigure, fixingAgent],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agent Health</h2>
          <p className="text-muted-foreground">
            {agents.length > 0
              ? `${healthy.length} healthy, ${unhealthy.length} with issues`
              : "Monitor agent status, dependencies, and runtime health"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center rounded-lg border p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2", viewMode === "grid" && "bg-muted")}
              onClick={() => toggleView("grid")}
              title="Grid view"
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2", viewMode === "table" && "bg-muted")}
              onClick={() => toggleView("table")}
              title="Table view"
            >
              <List className="size-4" />
            </Button>
          </div>
          {totalFixable > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="text-amber-600 border-amber-500/30 hover:bg-amber-500/10"
              onClick={() => {
                void handleFixAllIssues();
              }}
              disabled={fixingAll || !!fixingAgent}
            >
              {fixingAll ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              <span className="ml-1.5">Fix All Issues ({totalFixable})</span>
            </Button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="rounded"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void fetchHealth();
            }}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            <span className="ml-1.5">Check</span>
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      {agents.length > 0 && (
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="size-4 text-green-600" />
            <span>{healthy.length} healthy</span>
          </div>
          {unhealthy.length > 0 && (
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="size-4 text-amber-500" />
              <span>{unhealthy.length} with issues</span>
            </div>
          )}
          {totalFixable > 0 && (
            <div className="flex items-center gap-1.5">
              <Wand2 className="size-4 text-amber-600" />
              <span>{totalFixable} auto-fixable</span>
            </div>
          )}
          {deployStatuses.length > 0 &&
            (() => {
              const deployed = deployStatuses.filter((d) => d.deployed);
              const needsUpgrade = deployStatuses.filter((d) => d.needsUpgrade);
              const undeployed = deployStatuses.filter((d) => !d.deployed);
              return (
                <>
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="size-4 text-green-600" />
                    <span>
                      {deployed.length}/{deployStatuses.length} deployed
                    </span>
                  </div>
                  {needsUpgrade.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <ArrowUpCircle className="size-4 text-amber-500" />
                      <span>{needsUpgrade.length} upgradable</span>
                    </div>
                  )}
                  {undeployed.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <Upload className="size-4 text-blue-500" />
                      <span>{undeployed.length} not deployed</span>
                    </div>
                  )}
                </>
              );
            })()}
        </div>
      )}

      {/* Config sync banner */}
      {configSyncIssues.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-amber-500 shrink-0" />
            <div>
              <p className="font-medium text-sm">Config out of sync</p>
              <p className="text-xs text-muted-foreground">
                {configSyncIssues.length} issue{configSyncIssues.length !== 1 ? "s" : ""} detected
                between YAML manifests and gateway config
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500/30 text-amber-600 hover:bg-amber-500/10"
            onClick={() => {
              void handleSyncAll();
            }}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin mr-1.5" />
            ) : (
              <RefreshCw className="size-4 mr-1.5" />
            )}
            Sync All to Config
          </Button>
        </div>
      )}

      {agents.length === 0 && !loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
          <div className="text-center space-y-2">
            <Activity className="mx-auto size-10 text-muted-foreground" />
            <h3 className="font-semibold">No agents to monitor</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Install agents to see their health status, or run health checks via CLI:
              <code className="block mt-2 text-xs bg-muted px-2 py-1 rounded">
                openclaw agents health --all
              </code>
            </p>
          </div>
        </div>
      ) : viewMode === "table" ? (
        <DataTable<AgentHealth>
          columns={tableColumns}
          data={[...unhealthy, ...healthy]}
          keyField="id"
          compact
          onRowClick={(row) => handleConfigure(row.id)}
          rowClassName={(row) =>
            row.status === "error"
              ? "bg-destructive/5"
              : row.status === "degraded"
                ? "bg-amber-500/5"
                : ""
          }
          emptyMessage="No agents to monitor"
          pageSize={20}
        />
      ) : (
        <div className="space-y-4">
          {unhealthy.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-destructive mb-3">Needs Attention</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {unhealthy.map((a) => (
                  <HealthCard
                    key={a.id}
                    agent={a}
                    deployStatus={deployStatuses.find((d) => d.agentId === a.id)}
                    onConfigure={handleConfigure}
                    onFix={handleFix}
                    onDeploy={handleDeploy}
                    fixStates={fixStates}
                    fixingAgent={fixingAgent}
                  />
                ))}
              </div>
            </section>
          )}
          {healthy.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-muted-foreground mb-3">Healthy</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {healthy.map((a) => (
                  <HealthCard
                    key={a.id}
                    agent={a}
                    deployStatus={deployStatuses.find((d) => d.agentId === a.id)}
                    onConfigure={handleConfigure}
                    onFix={handleFix}
                    onDeploy={handleDeploy}
                    fixStates={fixStates}
                    fixingAgent={fixingAgent}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Fix preview dialog */}
      <FixPreviewDialog
        open={previewOpen}
        agentId={previewAgentId}
        fixType={previewFixType}
        content={previewContent}
        onApply={handleApplyPreview}
        onRegenerate={handleRegenerate}
        onClose={() => setPreviewOpen(false)}
        applying={applying}
        regenerating={regenerating}
      />

      {/* Toast notification */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
