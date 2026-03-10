import {
  Store,
  Search,
  Download,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Package,
  Plus,
  Pencil,
  Trash2,
  X,
  GitBranch,
  LayoutGrid,
  List,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useCreateAgentStore } from "@/store/create-agent-store";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────────────

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
  deprecated?: boolean;
  sunset_date?: string | null;
  replacement?: string | null;
}

interface BundleAgent {
  id: string;
  name: string;
  tier: number;
  role: string;
  installed: boolean;
}

interface MarketplaceBundle {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  bundle_agents: string[];
  includedAgents: BundleAgent[];
  agentCount: number;
  allInstalled: boolean;
}

// ── Agent card ───────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: number }) {
  const label = tier === 1 ? "Core" : tier === 2 ? "Dept Head" : "Specialist";
  const color =
    tier === 1
      ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
      : tier === 2
        ? "bg-blue-500/10 text-blue-600 border-blue-500/20"
        : "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
  return (
    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full border", color)}>
      T{tier} {label}
    </span>
  );
}

function BundleBadge() {
  return (
    <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-purple-500/10 text-purple-500 border-purple-500/20 flex items-center gap-1">
      <Package className="size-3" /> Bundle
    </span>
  );
}

function AgentCard({
  agent,
  onInstall,
  onPreview,
  installing,
}: {
  agent: MarketplaceAgent;
  onInstall: (id: string) => void;
  onPreview: (id: string) => void;
  installing: string | null;
}) {
  const isInstalled = agent.installStatus.startsWith("installed");
  const isInstalling = installing === agent.id;

  return (
    <div
      className="rounded-lg border p-4 space-y-3 hover:border-foreground/20 transition-colors cursor-pointer"
      onClick={() => onPreview(agent.id)}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{agent.name}</h3>
            <TierBadge tier={agent.tier} />
          </div>
          <p className="text-sm text-muted-foreground">{agent.role}</p>
        </div>
        {isInstalled ? (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="size-3.5" /> Installed
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onInstall(agent.id);
            }}
            disabled={isInstalling}
          >
            {isInstalling ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            <span className="ml-1">Install</span>
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2">{agent.description}</p>

      {agent.deprecated && (
        <p className="text-xs text-amber-600 bg-amber-500/10 rounded px-2 py-1">
          Deprecated{agent.sunset_date ? ` — sunset ${agent.sunset_date}` : ""}
          {agent.replacement ? `. Use ${agent.replacement} instead.` : ""}
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>v{agent.version}</span>
        <span>{agent.department}</span>
        {agent.requires && <span>requires: {agent.requires}</span>}
      </div>

      {agent.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.capabilities.slice(0, 3).map((cap) => (
            <span
              key={cap}
              className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {cap.replace(/_/g, " ")}
            </span>
          ))}
          {agent.capabilities.length > 3 && (
            <span className="text-xs px-1.5 py-0.5 text-muted-foreground">
              +{agent.capabilities.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Bundle card ─────────────────────────────────────────────────────────────

function BundleCard({
  bundle,
  onInstall,
  onEdit,
  onDelete,
  onViewOrg,
  installing,
}: {
  bundle: MarketplaceBundle;
  onInstall: (id: string) => void;
  onEdit: (bundle: MarketplaceBundle) => void;
  onDelete: (id: string) => void;
  onViewOrg: (bundle: MarketplaceBundle) => void;
  installing: string | null;
}) {
  const isInstalling = installing === bundle.id;
  const installedCount = bundle.includedAgents.filter((a) => a.installed).length;
  const isPartial = installedCount > 0 && !bundle.allInstalled;

  return (
    <div className="rounded-lg border p-4 space-y-3 hover:border-foreground/20 transition-colors">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{bundle.name}</h3>
            <BundleBadge />
          </div>
          <p className="text-sm text-muted-foreground">{bundle.description}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => onViewOrg(bundle)}
            className="rounded p-1 hover:bg-muted transition-colors"
            title="View in org chart"
          >
            <GitBranch className="size-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => onEdit(bundle)}
            className="rounded p-1 hover:bg-muted transition-colors"
            title="Edit bundle"
          >
            <Pencil className="size-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => onDelete(bundle.id)}
            className="rounded p-1 hover:bg-destructive/10 transition-colors"
            title="Delete bundle"
          >
            <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>v{bundle.version}</span>
        {bundle.allInstalled ? (
          <span className="flex items-center gap-1 text-green-600">
            <CheckCircle2 className="size-3" /> All {bundle.agentCount} installed
          </span>
        ) : isPartial ? (
          <span className="text-amber-500">
            {installedCount}/{bundle.agentCount} installed
          </span>
        ) : (
          <span>{bundle.agentCount} agents</span>
        )}
      </div>

      {/* Progress bar for partial installs */}
      {isPartial && (
        <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-500 transition-all"
            style={{ width: `${(installedCount / bundle.agentCount) * 100}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {bundle.includedAgents.map((agent) => (
          <span
            key={agent.id}
            className={cn(
              "text-xs px-2 py-0.5 rounded-md",
              agent.installed ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground",
            )}
          >
            {agent.name}
            {agent.installed && <CheckCircle2 className="inline size-3 ml-1" />}
          </span>
        ))}
      </div>

      {!bundle.allInstalled && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => {
            onInstall(bundle.id);
          }}
          disabled={isInstalling}
        >
          {isInstalling ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className="ml-1.5">
            {isPartial ? `Install Remaining ${bundle.agentCount - installedCount}` : "Install All"}
          </span>
        </Button>
      )}
    </div>
  );
}

// ── Bundle form modal ───────────────────────────────────────────────────────

function BundleFormModal({
  agents,
  editBundle,
  onSave,
  onClose,
}: {
  agents: MarketplaceAgent[];
  editBundle: MarketplaceBundle | null;
  onSave: (data: { id: string; name: string; description: string; agents: string[] }) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(editBundle?.id ?? "");
  const [name, setName] = useState(editBundle?.name ?? "");
  const [description, setDescription] = useState(editBundle?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(editBundle?.bundle_agents ?? []));
  const isEditing = !!editBundle;

  const departments = useMemo(() => {
    const map = new Map<string, MarketplaceAgent[]>();
    for (const a of agents) {
      const dept = a.department || "other";
      if (!map.has(dept)) {
        map.set(dept, []);
      }
      map.get(dept)!.push(a);
    }
    return map;
  }, [agents]);

  const toggle = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (!name.trim() || selected.size === 0) {
      return;
    }
    const finalId = isEditing
      ? editBundle.id
      : id.trim() ||
        name
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
    onSave({
      id: finalId,
      name: name.trim(),
      description: description.trim(),
      agents: [...selected],
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-lg">
            {isEditing ? `Edit Bundle: ${editBundle.name}` : "Create Bundle"}
          </h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {!isEditing && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Bundle ID</label>
              <Input
                placeholder="my-custom-pack"
                value={id}
                onChange={(e) => setId(e.target.value)}
                className="mt-1"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input
              placeholder="My Custom Pack"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <Input
              placeholder="A custom bundle for..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
            />
          </div>

          {/* Agent checklist by department */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Select Agents ({selected.size} selected)
            </label>
            <div className="mt-2 space-y-3 max-h-[250px] overflow-auto">
              {[...departments.entries()].map(([dept, deptAgents]) => (
                <div key={dept}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                    {dept}
                  </p>
                  <div className="space-y-1">
                    {deptAgents.map((agent) => (
                      <label
                        key={agent.id}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 cursor-pointer transition-colors",
                          selected.has(agent.id)
                            ? "bg-primary/10 border border-primary/30"
                            : "hover:bg-muted border border-transparent",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(agent.id)}
                          onChange={() => toggle(agent.id)}
                          className="rounded"
                        />
                        <span className="text-sm flex-1">{agent.name}</span>
                        <TierBadge tier={agent.tier} />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!name.trim() || selected.size === 0}>
            {isEditing ? "Save Changes" : "Create Bundle"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Delete confirmation ─────────────────────────────────────────────────────

function DeleteConfirmModal({
  bundleId,
  onConfirm,
  onClose,
}: {
  bundleId: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4">
        <h3 className="font-semibold">Delete Bundle</h3>
        <p className="text-sm text-muted-foreground">
          Delete bundle "{bundleId}"? This removes the bundle definition only — installed agents
          will remain.
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onConfirm();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Filter tabs ──────────────────────────────────────────────────────────────

function FilterTabs({
  value,
  onChange,
  counts,
}: {
  value: string;
  onChange: (v: string) => void;
  counts: Record<string, number>;
}) {
  const tabs = [
    { key: "all", label: "All" },
    { key: "department-head", label: "Department Heads" },
    { key: "specialist", label: "Specialists" },
    { key: "core", label: "Core" },
    { key: "bundle", label: "Bundles" },
  ];

  return (
    <div className="flex gap-1 rounded-lg border p-1 w-fit">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            "text-xs px-3 py-1.5 rounded-md transition-colors",
            value === tab.key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {counts[tab.key] !== undefined && (
            <span className="ml-1 opacity-60">({counts[tab.key]})</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentBrowsePage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const navigate = useNavigate();
  const openCreateAgent = useCreateAgentStore((s) => s.openCreateAgent);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [bundles, setBundles] = useState<MarketplaceBundle[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);

  // View mode
  type ViewMode = "grid" | "table";
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem("browse-view-mode") as ViewMode) || "grid";
    } catch {
      return "grid";
    }
  });
  const toggleView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem("browse-view-mode", mode);
    } catch {}
  }, []);

  // Bundle CRUD state
  const [showBundleForm, setShowBundleForm] = useState(false);
  const [editingBundle, setEditingBundle] = useState<MarketplaceBundle | null>(null);
  const [deletingBundleId, setDeletingBundleId] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    setLoading(true);
    try {
      const [agentsRes, bundlesRes] = await Promise.all([
        sendRpc("agents.marketplace.browse", {}),
        sendRpc("agents.marketplace.bundles", {}),
      ]);
      if (agentsRes && Array.isArray(agentsRes.agents)) {
        setAgents(agentsRes.agents as MarketplaceAgent[]);
      }
      if (bundlesRes && Array.isArray(bundlesRes.bundles)) {
        setBundles(bundlesRes.bundles as MarketplaceBundle[]);
      }
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [isConnected, sendRpc]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const filtered = useMemo(() => {
    let result = agents;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q) ||
          a.keywords?.some((k) => k.toLowerCase().includes(q)),
      );
    }
    if (category !== "all") {
      result = result.filter((a) => a.category === category);
    }
    return result;
  }, [agents, search, category]);

  const counts = useMemo(
    () => ({
      all: agents.length,
      core: agents.filter((a) => a.category === "core").length,
      "department-head": agents.filter((a) => a.category === "department-head").length,
      specialist: agents.filter((a) => a.category === "specialist").length,
      bundle: bundles.length,
    }),
    [agents, bundles],
  );

  const handleInstall = useCallback(
    async (agentId: string) => {
      setInstalling(agentId);
      try {
        await sendRpc("agents.marketplace.install", { agentId, scope: "project" });
        await fetchAgents();
      } catch {
        // Install not available via RPC yet
      } finally {
        setInstalling(null);
      }
    },
    [sendRpc, fetchAgents],
  );

  const handleBundleInstall = useCallback(
    async (bundleId: string) => {
      setInstalling(bundleId);
      try {
        await sendRpc("agents.marketplace.bundle.install", { bundleId, scope: "project" });
        await fetchAgents();
      } catch {
        // fallback
      } finally {
        setInstalling(null);
      }
    },
    [sendRpc, fetchAgents],
  );

  const handleBundleSave = useCallback(
    async (data: { id: string; name: string; description: string; agents: string[] }) => {
      try {
        if (editingBundle) {
          await sendRpc("agents.marketplace.bundle.update", {
            bundleId: data.id,
            name: data.name,
            description: data.description,
            agents: data.agents,
          });
        } else {
          await sendRpc("agents.marketplace.bundle.create", {
            id: data.id,
            name: data.name,
            description: data.description,
            agents: data.agents,
          });
        }
        setShowBundleForm(false);
        setEditingBundle(null);
        await fetchAgents();
      } catch {
        // RPC error
      }
    },
    [sendRpc, fetchAgents, editingBundle],
  );

  const handleBundleDelete = useCallback(async () => {
    if (!deletingBundleId) {
      return;
    }
    try {
      await sendRpc("agents.marketplace.bundle.delete", { bundleId: deletingBundleId });
      setDeletingBundleId(null);
      await fetchAgents();
    } catch {
      // RPC error
    }
  }, [sendRpc, fetchAgents, deletingBundleId]);

  const tableColumns = useMemo<Column<MarketplaceAgent>[]>(
    () => [
      {
        key: "name",
        header: "Name",
        sortable: true,
        render: (row) => <span className="font-semibold">{row.name}</span>,
      },
      {
        key: "role",
        header: "Role",
        sortable: true,
        render: (row) => <span className="text-muted-foreground">{row.role}</span>,
      },
      {
        key: "tier",
        header: "Tier",
        sortable: true,
        render: (row) => <TierBadge tier={row.tier} />,
      },
      {
        key: "department",
        header: "Department",
        sortable: true,
      },
      {
        key: "version",
        header: "Version",
        render: (row) => <span className="text-muted-foreground text-xs">v{row.version}</span>,
      },
      {
        key: "installStatus",
        header: "Status",
        sortable: true,
        render: (row) =>
          row.installStatus.startsWith("installed") ? (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle2 className="size-3" /> Installed
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={(e) => {
                e.stopPropagation();
                void handleInstall(row.id);
              }}
              disabled={installing === row.id}
            >
              {installing === row.id ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              <span className="ml-1">Install</span>
            </Button>
          ),
      },
      {
        key: "requires",
        header: "Parent",
        sortable: true,
        render: (row) => (
          <span className="text-xs text-muted-foreground">{row.requires ?? "—"}</span>
        ),
      },
    ],
    [handleInstall, installing],
  );

  const isBundleView = category === "bundle";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agent Registry</h2>
          <p className="text-muted-foreground">Browse agent blueprints, bundles, and registries</p>
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
          {isBundleView ? (
            <Button
              size="sm"
              onClick={() => {
                setEditingBundle(null);
                setShowBundleForm(true);
              }}
            >
              <Plus className="size-4" />
              <span className="ml-1.5">Create Bundle</span>
            </Button>
          ) : (
            <Button size="sm" onClick={() => openCreateAgent()}>
              <Plus className="size-4 mr-1" />
              Create Agent
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void fetchAgents();
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

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <FilterTabs value={category} onChange={setCategory} counts={counts} />
      </div>

      {isBundleView ? (
        bundles.length === 0 && !loading ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
            <div className="text-center space-y-3">
              <Package className="mx-auto size-10 text-muted-foreground" />
              <h3 className="font-semibold">No Bundles</h3>
              <p className="text-sm text-muted-foreground max-w-md">
                Bundles are pre-packaged sets of agents for common team configurations.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setEditingBundle(null);
                  setShowBundleForm(true);
                }}
              >
                <Plus className="size-4" />
                <span className="ml-1.5">Create Your First Bundle</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bundles.map((bundle) => (
              <BundleCard
                key={bundle.id}
                bundle={bundle}
                onInstall={handleBundleInstall}
                onEdit={(b) => {
                  setEditingBundle(b);
                  setShowBundleForm(true);
                }}
                onDelete={setDeletingBundleId}
                onViewOrg={(b) => navigate(`/agents/organization?bundle=${b.id}`)}
                installing={installing}
              />
            ))}
          </div>
        )
      ) : filtered.length === 0 && !loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
          <div className="text-center space-y-2">
            <Store className="mx-auto size-10 text-muted-foreground" />
            <h3 className="font-semibold">
              {agents.length === 0 ? "Agent Marketplace" : "No matches"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {agents.length === 0
                ? "Connect to the gateway to browse available agents, or sync a registry via CLI."
                : "Try a different search term or category filter."}
            </p>
          </div>
        </div>
      ) : viewMode === "table" ? (
        <DataTable<MarketplaceAgent>
          columns={tableColumns}
          data={filtered}
          keyField="id"
          compact
          onRowClick={(row) => navigate(`/agents/preview/${row.id}`)}
          emptyMessage="No agents found"
          pageSize={20}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onInstall={handleInstall}
              onPreview={(id) => navigate(`/agents/preview/${id}`)}
              installing={installing}
            />
          ))}
        </div>
      )}

      {/* Bundle form modal (create / edit) */}
      {showBundleForm && (
        <BundleFormModal
          agents={agents}
          editBundle={editingBundle}
          onSave={handleBundleSave}
          onClose={() => {
            setShowBundleForm(false);
            setEditingBundle(null);
          }}
        />
      )}

      {/* Delete confirmation modal */}
      {deletingBundleId && (
        <DeleteConfirmModal
          bundleId={deletingBundleId}
          onConfirm={handleBundleDelete}
          onClose={() => setDeletingBundleId(null)}
        />
      )}
    </div>
  );
}
