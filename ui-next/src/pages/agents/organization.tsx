import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  RefreshCw,
  Loader2,
  Network,
  X,
  ChevronDown,
  Package,
  Rocket,
  CheckCircle2,
  AlertCircle,
  Save,
  Pencil,
  Plus,
  Minus,
} from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { AgentConfigDialog } from "@/components/agents/agent-config-dialog";
import { AgentFlowNodeComponent, setNodeActions } from "@/components/agents/agent-flow-node";
import { AgentHealthDialog } from "@/components/agents/agent-health-dialog";
import { AgentPreviewDialog } from "@/components/agents/agent-preview-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { DepartmentEdgeComponent } from "@/components/agents/department-edge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { buildOrgGraph } from "@/lib/agent-org-graph";
import { DEPARTMENT_COLORS } from "@/lib/matrix-tier-map";
import { cn } from "@/lib/utils";
import {
  useAgentPreviewStore,
  useAgentConfigStore,
  useAgentHealthStore,
} from "@/store/agent-dialog-store";
import { useCreateAgentStore } from "@/store/create-agent-store";
import { useGatewayStore } from "@/store/gateway-store";

// Register custom node and edge types (stable reference — must be outside component)
const nodeTypes: NodeTypes = {
  agent: AgentFlowNodeComponent,
};

const edgeTypes: EdgeTypes = {
  department: DepartmentEdgeComponent,
};

interface MarketplaceAgent {
  id: string;
  name: string;
  tier: number;
  role: string;
  department: string;
  version: string;
  description: string;
  capabilities: string[];
  keywords: string[];
  category: string;
  installStatus: string;
  requires?: string | null;
  enabled?: boolean;
  bundled?: boolean;
}

interface MarketplaceBundle {
  id: string;
  name: string;
  description?: string;
  version?: string;
  bundle_agents: string[];
  agentCount?: number;
  allInstalled?: boolean;
}

interface HealthCheck {
  agentId: string;
  checks: Array<{ check: string; status: string }>;
}

const LEGEND_ITEMS = [
  { label: "Operations", color: DEPARTMENT_COLORS.operations },
  { label: "Engineering", color: DEPARTMENT_COLORS.engineering },
  { label: "Finance", color: DEPARTMENT_COLORS.finance },
  { label: "Marketing", color: DEPARTMENT_COLORS.marketing },
];

// ── Toast component ─────────────────────────────────────────────────────────

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
        "fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg text-sm",
        type === "success"
          ? "bg-green-600/10 border-green-600/30 text-green-400"
          : "bg-destructive/10 border-destructive/30 text-destructive",
      )}
    >
      {type === "success" ? (
        <CheckCircle2 className="size-4" />
      ) : (
        <AlertCircle className="size-4" />
      )}
      {message}
    </div>
  );
}

// ── Bundle selector dropdown ────────────────────────────────────────────────

function BundleDiffBadge({
  current,
  target,
}: {
  current: MarketplaceBundle | null;
  target: MarketplaceBundle;
}) {
  if (!current || current.id === target.id) {
    return null;
  }
  const currentSet = new Set(current.bundle_agents);
  const targetSet = new Set(target.bundle_agents);
  const added = target.bundle_agents.filter((id) => !currentSet.has(id)).length;
  const removed = current.bundle_agents.filter((id) => !targetSet.has(id)).length;
  if (!added && !removed) {
    return null;
  }
  return (
    <span className="flex items-center gap-1 text-[9px]">
      {added > 0 && (
        <span className="text-green-500 flex items-center">
          <Plus className="size-2.5" />
          {added}
        </span>
      )}
      {removed > 0 && (
        <span className="text-red-400 flex items-center">
          <Minus className="size-2.5" />
          {removed}
        </span>
      )}
    </span>
  );
}

function BundleSelector({
  bundles,
  activeBundle,
  activeBundleObj,
  onSelect,
}: {
  bundles: MarketplaceBundle[];
  activeBundle: string | null;
  activeBundleObj: MarketplaceBundle | null;
  onSelect: (bundleId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activeName = bundles.find((b) => b.id === activeBundle)?.name;

  return (
    <div className="relative" ref={ref}>
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)} className="gap-1.5">
        <Package className="size-3.5" />
        {activeName ?? "All Bundles"}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 w-64 bg-card border rounded-lg shadow-lg py-1 max-h-64 overflow-auto">
          <button
            className={cn(
              "w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors",
              !activeBundle && "font-medium text-foreground",
            )}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            All Bundles
          </button>
          {bundles.length > 0 && <div className="border-t my-1" />}
          {bundles.map((b) => (
            <button
              key={b.id}
              className={cn(
                "w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors",
                activeBundle === b.id && "font-medium text-foreground",
              )}
              onClick={() => {
                onSelect(b.id);
                setOpen(false);
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{b.name}</span>
                <BundleDiffBadge current={activeBundleObj} target={b} />
              </div>
              <div className="text-[10px] text-muted-foreground">
                {b.agentCount ?? b.bundle_agents.length} agents
                {b.allInstalled && <span className="ml-1 text-green-500">installed</span>}
              </div>
            </button>
          ))}
          {bundles.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No bundles available</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Bundle status overlay ───────────────────────────────────────────────────

function BundleOverlay({
  bundle,
  onInstall,
  onDelete,
  installing,
}: {
  bundle: MarketplaceBundle;
  onInstall: () => void;
  onDelete: () => void;
  installing: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="absolute bottom-3 left-[100px] z-10 bg-card/90 backdrop-blur border rounded-lg px-3 py-2.5 space-y-2 max-w-[220px]">
      <div>
        <span className="text-xs font-semibold">{bundle.name}</span>
        {bundle.version && (
          <span className="text-[10px] text-muted-foreground ml-1.5">v{bundle.version}</span>
        )}
      </div>
      {bundle.description && (
        <p className="text-[10px] text-muted-foreground leading-snug">{bundle.description}</p>
      )}
      <div className="text-[10px] text-muted-foreground">
        {bundle.agentCount ?? bundle.bundle_agents.length} agents
        {bundle.allInstalled && <span className="ml-1 text-green-500">— all installed</span>}
      </div>
      <div className="flex items-center gap-1.5 pt-1">
        {!bundle.allInstalled && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2"
            onClick={() => {
              onInstall();
            }}
            disabled={installing}
          >
            {installing ? (
              <Loader2 className="size-3 animate-spin mr-1" />
            ) : (
              <Rocket className="size-3 mr-1" />
            )}
            Install All
          </Button>
        )}
        {confirmDelete ? (
          <div className="flex gap-1">
            <Button
              variant="destructive"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => {
                onDelete();
              }}
            >
              Confirm
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              onClick={() => setConfirmDelete(false)}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2 hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Save / Edit Bundle dialog ────────────────────────────────────────────────

function BundleFormDialog({
  open,
  onClose,
  onSave,
  saving,
  agents,
  editBundle,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: { id: string; name: string; description: string; agents: string[] }) => void;
  saving: boolean;
  agents: MarketplaceAgent[];
  editBundle?: MarketplaceBundle | null;
}) {
  const isEdit = !!editBundle;
  const [bundleId, setBundleId] = useState(editBundle?.id ?? "");
  const [bundleName, setBundleName] = useState(editBundle?.name ?? "");
  const [description, setDescription] = useState(editBundle?.description ?? "");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    new Set(editBundle?.bundle_agents ?? []),
  );

  // Reset on open
  useEffect(() => {
    if (open) {
      setBundleId(editBundle?.id ?? "");
      setBundleName(editBundle?.name ?? "");
      setDescription(editBundle?.description ?? "");
      setSelectedAgents(new Set(editBundle?.bundle_agents ?? []));
    }
  }, [open, editBundle]);

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Group agents by department
  const departments = new Map<string, MarketplaceAgent[]>();
  for (const a of agents) {
    if (a.tier === 1) {
      continue;
    } // Skip COO
    const dept = a.department;
    if (!departments.has(dept)) {
      departments.set(dept, []);
    }
    departments.get(dept)!.push(a);
  }

  const idFromName = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg p-6 w-full max-w-lg space-y-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">{isEdit ? "Edit Bundle" : "Save as Bundle"}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            &times;
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Bundle Name *</label>
              <Input
                value={bundleName}
                onChange={(e) => {
                  setBundleName(e.target.value);
                  if (!isEdit && (!bundleId || bundleId === idFromName(bundleName))) {
                    setBundleId(idFromName(e.target.value));
                  }
                }}
                placeholder="My Bundle"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Bundle ID *</label>
              <Input
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder="my-bundle"
                disabled={isEdit}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this bundle is for..."
              className="mt-1"
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto border rounded-md">
          <div className="px-3 py-2 border-b bg-muted/30">
            <span className="text-xs font-medium">
              Select Agents ({selectedAgents.size} selected)
            </span>
          </div>
          <div className="divide-y max-h-[300px] overflow-auto">
            {[...departments.entries()]
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([dept, deptAgents]) => (
                <div key={dept} className="px-3 py-2">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1.5">
                    {dept}
                  </div>
                  {deptAgents.map((a) => (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-muted/30 rounded px-1"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAgents.has(a.id)}
                        onChange={() => toggleAgent(a.id)}
                        className="size-3.5"
                      />
                      <span className="text-sm">{a.name}</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">T{a.tier}</span>
                    </label>
                  ))}
                </div>
              ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!bundleId || !bundleName || selectedAgents.size === 0 || saving}
            onClick={() =>
              onSave({ id: bundleId, name: bundleName, description, agents: [...selectedAgents] })
            }
          >
            {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
            {isEdit ? "Update Bundle" : "Create Bundle"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function AgentOrganizationPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const [searchParams, setSearchParams] = useSearchParams();
  const bundleFilter = searchParams.get("bundle");

  const openCreateAgent = useCreateAgentStore((s) => s.openCreateAgent);
  const openPreview = useAgentPreviewStore((s) => s.openPreview);
  const openConfig = useAgentConfigStore((s) => s.openConfig);
  const openHealth = useAgentHealthStore((s) => s.openHealth);

  const [allAgents, setAllAgents] = useState<MarketplaceAgent[]>([]);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [bundles, setBundles] = useState<MarketplaceBundle[]>([]);
  const [activeBundle, setActiveBundle] = useState<MarketplaceBundle | null>(null);
  const [_healthMap, setHealthMap] = useState<Record<string, "healthy" | "warning" | "error">>({});
  const [loading, setLoading] = useState(false);
  const [installingBundle, setInstallingBundle] = useState(false);
  const [savingBundle, setSavingBundle] = useState(false);
  const [showBundleForm, setShowBundleForm] = useState<"create" | "edit" | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Wire node actions (runs once on mount + when handlers change)
  useEffect(() => {
    setNodeActions({
      onPreview: (agentId) => openPreview(agentId),
      onEdit: (agentId) => openConfig(agentId),
      onClone: (agentId) => openCreateAgent({ cloneId: agentId }),
      onAddSpecialist: (agentId, department) => openCreateAgent({ parentId: agentId, department }),
      onToggleEnabled: async (agentId, currentlyDisabled) => {
        try {
          const method = currentlyDisabled
            ? "agents.marketplace.enable"
            : "agents.marketplace.disable";
          await sendRpc(method, { agentId });
          setToast({
            message: `Agent ${currentlyDisabled ? "enabled" : "disabled"}`,
            type: "success",
          });
          void fetchAndLayout();
        } catch {
          setToast({ message: "Failed to toggle agent", type: "error" });
        }
      },
      onDelete: async (agentId) => {
        try {
          await sendRpc("agents.marketplace.remove", { agentId });
          setToast({ message: "Agent removed", type: "success" });
          void fetchAndLayout();
        } catch {
          setToast({ message: "Failed to remove agent", type: "error" });
        }
      },
      onHealthClick: (agentId) => openHealth(agentId),
    });
  }, [openCreateAgent, openPreview, openConfig, openHealth, sendRpc]);

  const fetchAndLayout = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    setLoading(true);
    try {
      const [agentsRes, bundlesRes, healthRes] = await Promise.all([
        sendRpc("agents.marketplace.browse", {}),
        sendRpc("agents.marketplace.bundles", {}),
        sendRpc("agents.marketplace.health", {}).catch(() => null),
      ]);

      let fetched: MarketplaceAgent[] = [];
      if (agentsRes && Array.isArray(agentsRes.agents)) {
        fetched = agentsRes.agents as MarketplaceAgent[];
        setAllAgents(fetched);
      }

      // Parse bundles
      const fetchedBundles: MarketplaceBundle[] =
        bundlesRes && Array.isArray(bundlesRes.bundles)
          ? (bundlesRes.bundles as MarketplaceBundle[])
          : [];
      setBundles(fetchedBundles);

      // Parse health
      const hMap: Record<string, "healthy" | "warning" | "error"> = {};
      if (healthRes && Array.isArray(healthRes.results)) {
        for (const r of healthRes.results as HealthCheck[]) {
          const hasError = r.checks.some((c) => c.status === "fail");
          const hasWarn = r.checks.some((c) => c.status === "warn");
          hMap[r.agentId] = hasError ? "error" : hasWarn ? "warning" : "healthy";
        }
      }
      setHealthMap(hMap);

      // Determine active bundle filter
      const currentBundleId = bundleFilter;
      let _filteredBundle: MarketplaceBundle | null = null;

      if (currentBundleId) {
        const bundle = fetchedBundles.find((b) => b.id === currentBundleId);
        if (bundle) {
          _filteredBundle = bundle;
          setActiveBundle(bundle);
          const ids = new Set(bundle.bundle_agents);
          const coo = fetched.find((a) => a.tier === 1);
          if (coo) {
            ids.add(coo.id);
          }
          for (const a of fetched) {
            if (ids.has(a.id) && a.requires) {
              ids.add(a.requires);
            }
          }
          fetched = fetched.filter((a) => ids.has(a.id));
        }
      } else {
        setActiveBundle(null);
      }

      setAgents(fetched);

      // Build graph with health + enabled data
      const enriched = fetched.map((a) => ({
        ...a,
        healthStatus: hMap[a.id],
        enabled: a.enabled !== false,
        bundled: a.bundled ?? false,
      }));
      const graph = buildOrgGraph(enriched);
      setNodes(graph.nodes);
      setEdges(graph.edges);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [isConnected, sendRpc, setNodes, setEdges, bundleFilter]);

  useEffect(() => {
    void fetchAndLayout();
  }, [fetchAndLayout]);

  // Listen to create-agent store close to refresh
  const createAgentOpen = useCreateAgentStore((s) => s.open);
  const prevCreateOpen = useRef(createAgentOpen);
  useEffect(() => {
    if (prevCreateOpen.current && !createAgentOpen) {
      // Dialog just closed — refresh
      void fetchAndLayout();
    }
    prevCreateOpen.current = createAgentOpen;
  }, [createAgentOpen, fetchAndLayout]);

  const handleBundleSelect = useCallback(
    (bundleId: string | null) => {
      if (bundleId) {
        setSearchParams({ bundle: bundleId });
      } else {
        setSearchParams({});
      }
    },
    [setSearchParams],
  );

  const handleDeployBundle = useCallback(async () => {
    if (!activeBundle) {
      return;
    }
    setInstallingBundle(true);
    try {
      const res = await sendRpc("agents.marketplace.bundle.install", { bundleId: activeBundle.id });
      const installed = (res as { installed?: string[] })?.installed ?? [];
      const skipped = (res as { skipped?: string[] })?.skipped ?? [];
      setToast({
        message: `Bundle deployed: ${installed.length} installed, ${skipped.length} skipped`,
        type: "success",
      });
      await fetchAndLayout();
    } catch {
      setToast({ message: "Failed to deploy bundle", type: "error" });
    } finally {
      setInstallingBundle(false);
    }
  }, [activeBundle, sendRpc, fetchAndLayout]);

  const handleDeleteBundle = useCallback(async () => {
    if (!activeBundle) {
      return;
    }
    try {
      await sendRpc("agents.marketplace.bundle.delete", { bundleId: activeBundle.id });
      setToast({ message: "Bundle deleted", type: "success" });
      setSearchParams({});
      await fetchAndLayout();
    } catch {
      setToast({ message: "Failed to delete bundle", type: "error" });
    }
  }, [activeBundle, sendRpc, setSearchParams, fetchAndLayout]);

  const handleSaveBundle = useCallback(
    async (data: { id: string; name: string; description: string; agents: string[] }) => {
      setSavingBundle(true);
      try {
        await sendRpc("agents.marketplace.bundle.create", {
          id: data.id,
          name: data.name,
          description: data.description,
          agents: data.agents,
        });
        setToast({ message: `Bundle "${data.name}" created`, type: "success" });
        setShowBundleForm(null);
        setSearchParams({ bundle: data.id });
        await fetchAndLayout();
      } catch {
        setToast({ message: "Failed to create bundle", type: "error" });
      } finally {
        setSavingBundle(false);
      }
    },
    [sendRpc, fetchAndLayout, setSearchParams],
  );

  const handleUpdateBundle = useCallback(
    async (data: { id: string; name: string; description: string; agents: string[] }) => {
      setSavingBundle(true);
      try {
        await sendRpc("agents.marketplace.bundle.update", {
          bundleId: data.id,
          name: data.name,
          description: data.description,
          agents: data.agents,
        });
        setToast({ message: `Bundle "${data.name}" updated`, type: "success" });
        setShowBundleForm(null);
        await fetchAndLayout();
      } catch {
        setToast({ message: "Failed to update bundle", type: "error" });
      } finally {
        setSavingBundle(false);
      }
    },
    [sendRpc, fetchAndLayout],
  );

  // MiniMap node color based on department
  const miniMapNodeColor = useCallback((node: { data?: { departmentColor?: string } }) => {
    return (node.data as { departmentColor?: string })?.departmentColor ?? "#64748b";
  }, []);

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <Network className="mx-auto size-10 text-muted-foreground" />
          <h3 className="font-semibold">Agent Organization</h3>
          <p className="text-sm text-muted-foreground">
            Connect to the gateway to view the agent hierarchy.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Force pointer-events on nodes so hover works even with elementsSelectable=false */}
      <style>{`.org-canvas .react-flow__node { pointer-events: all !important; }`}</style>

      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agent Organization</h2>
          <p className="text-muted-foreground">
            {activeBundle ? (
              <>
                Showing bundle:{" "}
                <span className="font-medium text-foreground">{activeBundle.name}</span>
              </>
            ) : (
              "Deployed agent hierarchy and department structure"
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BundleSelector
            bundles={bundles}
            activeBundle={bundleFilter}
            activeBundleObj={activeBundle}
            onSelect={handleBundleSelect}
          />
          {activeBundle && !activeBundle.allInstalled && (
            <Button
              size="sm"
              onClick={() => {
                void handleDeployBundle();
              }}
              disabled={installingBundle}
            >
              {installingBundle ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <Rocket className="size-4 mr-1" />
              )}
              Deploy Bundle
            </Button>
          )}
          {activeBundle && (
            <Button variant="outline" size="sm" onClick={() => setShowBundleForm("edit")}>
              <Pencil className="size-3.5 mr-1" />
              Edit Bundle
            </Button>
          )}
          {!bundleFilter && (
            <Button variant="outline" size="sm" onClick={() => setShowBundleForm("create")}>
              <Save className="size-3.5 mr-1" />
              Save as Bundle
            </Button>
          )}
          {bundleFilter && (
            <Button variant="outline" size="sm" onClick={() => handleBundleSelect(null)}>
              <X className="size-4" />
              <span className="ml-1.5">Clear</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void fetchAndLayout();
            }}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Flow canvas */}
      <div
        className="flex-1 rounded-lg border bg-background overflow-hidden relative org-canvas"
        style={{ minHeight: 500 }}
      >
        {agents.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-2">
              <Network className="mx-auto size-10 text-muted-foreground" />
              <h3 className="font-semibold">No Agents</h3>
              <p className="text-sm text-muted-foreground max-w-md">
                No agents available to display. Browse the marketplace to install agents.
              </p>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background gap={16} size={1} color="#ffffff08" />
            <Controls
              showInteractive={false}
              position="bottom-right"
              className="!bg-card !border-border !shadow-lg [&>button]:!bg-card [&>button]:!border-border [&>button]:!fill-foreground [&>button:hover]:!bg-muted"
            />
            <MiniMap
              nodeColor={miniMapNodeColor}
              maskColor="rgba(0, 0, 0, 0.7)"
              className="!bg-card !border-border"
              position="bottom-left"
            />
          </ReactFlow>
        )}

        {/* Bundle status overlay */}
        {activeBundle && agents.length > 0 && (
          <BundleOverlay
            bundle={activeBundle}
            onInstall={handleDeployBundle}
            onDelete={handleDeleteBundle}
            installing={installingBundle}
          />
        )}

        {/* Legend overlay */}
        {agents.length > 0 && (
          <div className="absolute top-3 right-3 bg-card/90 backdrop-blur border rounded-lg px-3 py-2 space-y-1.5">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Departments
            </span>
            {LEGEND_ITEMS.map((item) => (
              <div key={item.label} className="flex items-center gap-2">
                <div className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="text-xs text-muted-foreground">{item.label}</span>
              </div>
            ))}
            <div className="border-t pt-1.5 mt-1.5 space-y-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Tiers
              </span>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-4 rounded bg-muted-foreground/40" />
                <span className="text-xs text-muted-foreground">T1 Core</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-3.5 rounded bg-muted-foreground/30" />
                <span className="text-xs text-muted-foreground">T2 Dept Head</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-3 rounded bg-muted-foreground/20" />
                <span className="text-xs text-muted-foreground">T3 Specialist</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modal dialogs — all actions stay on canvas */}
      <CreateAgentDialog />
      <AgentPreviewDialog onAction={fetchAndLayout} />
      <AgentConfigDialog onSaved={fetchAndLayout} />
      <AgentHealthDialog onFixed={fetchAndLayout} />

      {/* Bundle form dialog */}
      <BundleFormDialog
        open={showBundleForm !== null}
        onClose={() => setShowBundleForm(null)}
        onSave={showBundleForm === "edit" ? handleUpdateBundle : handleSaveBundle}
        saving={savingBundle}
        agents={allAgents}
        editBundle={showBundleForm === "edit" ? activeBundle : null}
      />

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
