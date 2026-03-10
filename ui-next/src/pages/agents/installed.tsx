import {
  Package,
  RefreshCw,
  Trash2,
  Settings,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Power,
  PowerOff,
  Plus,
  Copy,
  LayoutGrid,
  List,
  Search,
  FileText,
  FolderOpen,
  Save,
  ChevronRight,
  ChevronDown,
  X,
  Edit3,
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
import type { AgentFile } from "@/types/agents";

// ── Types ────────────────────────────────────────────────────────────────────

interface InstalledAgent {
  id: string;
  name: string;
  tier: number;
  role: string;
  department: string;
  version: string;
  scope: "local" | "project" | "user";
  status: "active" | "disabled";
  disableReason?: string;
  capabilities: string[];
  requires?: string | null;
  deprecated?: boolean;
  sunset_date?: string | null;
  replacement?: string | null;
}

/** Workspace info loaded from agents.list + agents.files.list */
interface WorkspaceInfo {
  agentId: string;
  workspace: string;
  files: AgentFile[];
}

type ViewMode = "grid" | "table";

// ── Confirm dialog ──────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  variant = "destructive",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg p-6 w-full max-w-md space-y-4">
        <h3 className="font-semibold text-lg">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── File editor dialog ──────────────────────────────────────────────────────

function FileEditorDialog({
  agentId: _agentId,
  agentName,
  fileName,
  content,
  onSave,
  onClose,
  saving,
}: {
  agentId: string;
  agentName: string;
  fileName: string;
  content: string;
  onSave: (content: string) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [editContent, setEditContent] = useState(content);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <h3 className="font-semibold">{fileName}</h3>
            <p className="text-xs text-muted-foreground">{agentName} workspace</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => onSave(editContent)}
              disabled={saving || editContent === content}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin mr-1" />
              ) : (
                <Save className="size-3.5 mr-1" />
              )}
              Save
            </Button>
            <button onClick={onClose} className="rounded p-1 hover:bg-muted">
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden p-1">
          <textarea
            className="w-full h-full min-h-[400px] p-4 bg-background border rounded-md font-mono text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────

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

function StatusDot({ status }: { status: "active" | "disabled" }) {
  return status === "active" ? (
    <span className="flex items-center gap-1 text-xs text-green-600">
      <CheckCircle2 className="size-3" /> Active
    </span>
  ) : (
    <span className="flex items-center gap-1 text-xs text-destructive">
      <AlertTriangle className="size-3" /> Disabled
    </span>
  );
}

// ── Workspace files panel ───────────────────────────────────────────────────

const BOOTSTRAP_FILES = new Set([
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "USER.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
]);
const MEMORY_FILES = new Set(["memory.md"]);

function fileIcon(name: string) {
  if (name === "SOUL.md") {
    return "🧠";
  }
  if (name === "IDENTITY.md") {
    return "🪪";
  }
  if (name === "TOOLS.md") {
    return "🔧";
  }
  if (name === "HEARTBEAT.md") {
    return "💓";
  }
  if (name === "USER.md") {
    return "👤";
  }
  if (name === "AGENTS.md") {
    return "🏢";
  }
  if (name === "BOOTSTRAP.md") {
    return "🚀";
  }
  if (name.includes("memory")) {
    return "📝";
  }
  return "📄";
}

function WorkspaceFilesPanel({
  workspace,
  files,
  onEditFile,
}: {
  workspace: string;
  files: AgentFile[];
  onEditFile: (fileName: string) => void;
}) {
  const bootstrapFiles = files.filter((f) => BOOTSTRAP_FILES.has(f.name));
  const memoryFiles = files.filter((f) => MEMORY_FILES.has(f.name) || f.name.startsWith("memory/"));
  const presentCount = files.filter((f) => !f.missing).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FolderOpen className="size-3.5" />
        <span className="truncate font-mono">{workspace}</span>
        <span className="ml-auto shrink-0">
          {presentCount}/{files.length} files
        </span>
      </div>

      {/* Bootstrap files */}
      <div className="space-y-1">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Agent Files
        </p>
        {bootstrapFiles.map((f) => (
          <button
            key={f.name}
            className={cn(
              "flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 text-left transition-colors text-sm",
              f.missing ? "opacity-50 hover:bg-muted/50" : "hover:bg-muted",
            )}
            onClick={() => !f.missing && onEditFile(f.name)}
            disabled={f.missing}
          >
            <span>{fileIcon(f.name)}</span>
            <span className="flex-1">{f.name}</span>
            {f.missing ? (
              <span className="text-[10px] text-muted-foreground">not created</span>
            ) : (
              <>
                {f.size !== undefined && (
                  <span className="text-[10px] text-muted-foreground">
                    {f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}
                  </span>
                )}
                <Edit3 className="size-3 text-muted-foreground" />
              </>
            )}
          </button>
        ))}
      </div>

      {/* Memory files */}
      {memoryFiles.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Memory
          </p>
          {memoryFiles.map((f) => (
            <button
              key={f.name}
              className={cn(
                "flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 text-left transition-colors text-sm",
                f.missing ? "opacity-50" : "hover:bg-muted",
              )}
              onClick={() => !f.missing && onEditFile(f.name)}
              disabled={f.missing}
            >
              <span>{fileIcon(f.name)}</span>
              <span className="flex-1">{f.name}</span>
              {!f.missing && f.size !== undefined && (
                <span className="text-[10px] text-muted-foreground">
                  {f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}
                </span>
              )}
              {!f.missing && <Edit3 className="size-3 text-muted-foreground" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agent card (grid view) with workspace ───────────────────────────────────

function AgentCard({
  agent,
  workspaceInfo,
  expanded,
  onToggleExpand,
  onEdit,
  onToggle,
  onRemove,
  onClone,
  onCreateSpecialist,
  onEditFile,
}: {
  agent: InstalledAgent;
  workspaceInfo?: WorkspaceInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: (id: string) => void;
  onToggle: (id: string, enable: boolean) => void;
  onRemove: (id: string) => void;
  onClone: (id: string) => void;
  onCreateSpecialist?: (parentId: string, department: string) => void;
  onEditFile: (agentId: string, fileName: string) => void;
}) {
  const isDisabled = agent.status === "disabled";
  const isCore = agent.id === "operator1";

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors cursor-pointer",
        isDisabled ? "opacity-60 border-destructive/30" : "hover:border-foreground/20",
      )}
      onClick={() => onEdit(agent.id)}
    >
      {/* Card header */}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{agent.name}</h3>
              {isDisabled && <AlertTriangle className="size-4 text-destructive" />}
            </div>
            <p className="text-sm text-muted-foreground">{agent.role}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <TierBadge tier={agent.tier} />
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>v{agent.version}</span>
          <span>{agent.department}</span>
          {agent.requires && <span>requires: {agent.requires}</span>}
        </div>

        {agent.deprecated && (
          <p className="text-xs text-amber-600 bg-amber-500/10 rounded px-2 py-1">
            Deprecated{agent.sunset_date ? ` — sunset ${agent.sunset_date}` : ""}
            {agent.replacement ? `. Use ${agent.replacement} instead.` : ""}
          </p>
        )}

        <div
          className="flex items-center justify-between pt-1"
          onClick={(e) => e.stopPropagation()}
        >
          <StatusDot status={agent.status} />
          <div className="flex items-center gap-1">
            {/* Workspace toggle */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={onToggleExpand}
              title="Toggle workspace files"
            >
              <FileText className="size-3.5 mr-1" />
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => onEdit(agent.id)}
              title="Configure blueprint"
            >
              <Settings className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => onClone(agent.id)}
              title="Clone agent"
            >
              <Copy className="size-3.5" />
            </Button>
            {!isCore && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => onToggle(agent.id, isDisabled)}
                  title={isDisabled ? "Enable" : "Disable"}
                >
                  {isDisabled ? <Power className="size-3.5" /> : <PowerOff className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-destructive hover:text-destructive"
                  onClick={() => onRemove(agent.id)}
                  title="Remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
            {(agent.tier === 1 || agent.tier === 2) && onCreateSpecialist && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => onCreateSpecialist(agent.id, agent.department)}
                title="Create specialist under this agent"
              >
                <Plus className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Expanded workspace panel */}
      {expanded && workspaceInfo && (
        <div className="border-t px-4 py-3 bg-muted/30" onClick={(e) => e.stopPropagation()}>
          <WorkspaceFilesPanel
            workspace={workspaceInfo.workspace}
            files={workspaceInfo.files}
            onEditFile={(fileName) => onEditFile(agent.id, fileName)}
          />
        </div>
      )}
      {expanded && !workspaceInfo && (
        <div
          className="border-t px-4 py-3 bg-muted/30 text-center"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs text-muted-foreground">
            <Loader2 className="inline size-3 animate-spin mr-1" />
            Loading workspace...
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentInstalledPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const navigate = useNavigate();

  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filterTier, setFilterTier] = useState<string>("all");
  const [filterDept, setFilterDept] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem("agents-view-mode") as ViewMode) || "grid";
    } catch {
      return "grid";
    }
  });

  // Workspace state
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [workspaceCache, setWorkspaceCache] = useState<Record<string, WorkspaceInfo>>({});
  const [editingFile, setEditingFile] = useState<{
    agentId: string;
    agentName: string;
    fileName: string;
    content: string;
  } | null>(null);
  const [savingFile, setSavingFile] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    variant?: "destructive" | "default";
    onConfirm: () => void;
  }>({ open: false, title: "", description: "", confirmLabel: "", onConfirm: () => {} });

  const toggleView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem("agents-view-mode", mode);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    setLoading(true);
    try {
      const res = await sendRpc("agents.marketplace.installed", {});
      if (res && Array.isArray(res.agents)) {
        setAgents(res.agents as InstalledAgent[]);
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

  // Load workspace files for an agent
  const loadWorkspaceFiles = useCallback(
    async (agentId: string) => {
      // Map marketplace IDs to config IDs for the RPC
      const configId = agentId === "operator1" ? "main" : agentId;
      try {
        const res = await sendRpc("agents.files.list", { agentId: configId });
        if (res && res.files) {
          setWorkspaceCache((prev) => ({
            ...prev,
            [agentId]: {
              agentId,
              workspace: (res as { workspace?: string }).workspace ?? "",
              files: (res as { files: AgentFile[] }).files,
            },
          }));
        }
      } catch {
        // Workspace may not exist yet
        setWorkspaceCache((prev) => ({
          ...prev,
          [agentId]: { agentId, workspace: "not deployed", files: [] },
        }));
      }
    },
    [sendRpc],
  );

  // Toggle workspace expand
  const toggleExpand = useCallback(
    (agentId: string) => {
      setExpandedAgents((prev) => {
        const next = new Set(prev);
        if (next.has(agentId)) {
          next.delete(agentId);
        } else {
          next.add(agentId);
          if (!workspaceCache[agentId]) {
            void loadWorkspaceFiles(agentId);
          }
        }
        return next;
      });
    },
    [workspaceCache, loadWorkspaceFiles],
  );

  // Open file editor
  const handleEditFile = useCallback(
    async (agentId: string, fileName: string) => {
      const configId = agentId === "operator1" ? "main" : agentId;
      try {
        const res = await sendRpc("agents.files.get", { agentId: configId, name: fileName });
        if (res && (res as { file?: AgentFile }).file) {
          const file = (res as { file: AgentFile }).file;
          const agent = agents.find((a) => a.id === agentId);
          setEditingFile({
            agentId,
            agentName: agent?.name ?? agentId,
            fileName,
            content: file.content ?? "",
          });
        }
      } catch {
        // Failed to load file
      }
    },
    [sendRpc, agents],
  );

  // Save file
  const handleSaveFile = useCallback(
    async (content: string) => {
      if (!editingFile) {
        return;
      }
      setSavingFile(true);
      const configId = editingFile.agentId === "operator1" ? "main" : editingFile.agentId;
      try {
        await sendRpc("agents.files.set", {
          agentId: configId,
          name: editingFile.fileName,
          content,
        });
        setEditingFile(null);
        // Refresh workspace cache
        void loadWorkspaceFiles(editingFile.agentId);
      } catch {
        // Save failed
      } finally {
        setSavingFile(false);
      }
    },
    [editingFile, sendRpc, loadWorkspaceFiles],
  );

  const handleEdit = useCallback(
    (agentId: string) => {
      void navigate(`/agents/config/${agentId}`);
    },
    [navigate],
  );

  const handleToggle = useCallback(
    (agentId: string, enable: boolean) => {
      const action = enable ? "Enable" : "Disable";
      const agent = agents.find((a) => a.id === agentId);
      const dependents = agents.filter((a) => a.requires === agentId);
      const depWarning =
        !enable && dependents.length > 0
          ? ` ${dependents.length} specialist(s) depend on this agent and will stop receiving routed tasks.`
          : "";
      setConfirmDialog({
        open: true,
        title: `${action} ${agent?.name ?? agentId}?`,
        description: `This will ${action.toLowerCase()} the agent.${depWarning}`,
        confirmLabel: action,
        variant: enable ? "default" : "destructive",
        onConfirm: async () => {
          setConfirmDialog((d) => ({ ...d, open: false }));
          try {
            const method = enable ? "agents.marketplace.enable" : "agents.marketplace.disable";
            await sendRpc(method, { agentId });
            await fetchAgents();
          } catch {
            // RPC error
          }
        },
      });
    },
    [agents, sendRpc, fetchAgents],
  );

  const handleRemove = useCallback(
    (agentId: string) => {
      const agent = agents.find((a) => a.id === agentId);
      const dependents = agents.filter((a) => a.requires === agentId);
      const depWarning =
        dependents.length > 0
          ? ` This will also remove ${dependents.length} dependent specialist(s): ${dependents.map((d) => d.name).join(", ")}.`
          : "";
      setConfirmDialog({
        open: true,
        title: `Remove ${agent?.name ?? agentId}?`,
        description: `This will permanently uninstall the agent and delete its files.${depWarning}`,
        confirmLabel: "Remove",
        variant: "destructive",
        onConfirm: async () => {
          setConfirmDialog((d) => ({ ...d, open: false }));
          try {
            await sendRpc("agents.marketplace.remove", {
              agentId,
              cascade: dependents.length > 0,
            });
            await fetchAgents();
          } catch {
            // RPC error
          }
        },
      });
    },
    [agents, sendRpc, fetchAgents],
  );

  const openCreateAgent = useCreateAgentStore((s) => s.openCreateAgent);

  const handleClone = useCallback(
    (agentId: string) => {
      openCreateAgent({ cloneId: agentId });
    },
    [openCreateAgent],
  );

  const handleCreateSpecialist = useCallback(
    (parentId: string, department: string) => {
      openCreateAgent({ parentId, department });
    },
    [openCreateAgent],
  );

  // ── Search & filtering ────────────────────────────────────────────────────
  const departments = useMemo(
    () => [...new Set(agents.map((a) => a.department))].toSorted(),
    [agents],
  );

  const filtered = useMemo(() => {
    let result = agents;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q) ||
          a.department.toLowerCase().includes(q),
      );
    }
    if (filterTier !== "all") {
      result = result.filter((a) => a.tier === Number(filterTier));
    }
    if (filterDept !== "all") {
      result = result.filter((a) => a.department === filterDept);
    }
    if (filterStatus !== "all") {
      result = result.filter((a) => a.status === filterStatus);
    }
    return result;
  }, [agents, search, filterTier, filterDept, filterStatus]);

  const tier1 = filtered.filter((a) => a.tier === 1);
  const tier2 = filtered.filter((a) => a.tier === 2);
  const tier3 = filtered.filter((a) => a.tier === 3);
  const hasAgents = agents.length > 0;

  // ── Table columns ─────────────────────────────────────────────────────────

  const tableColumns = useMemo<Column<InstalledAgent>[]>(
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
        key: "status",
        header: "Status",
        sortable: true,
        render: (row) => <StatusDot status={row.status} />,
      },
      {
        key: "_workspace",
        header: "Workspace",
        render: (row) => {
          const ws = workspaceCache[row.id];
          const fileCount = ws ? ws.files.filter((f) => !f.missing).length : 0;
          return (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(row.id);
              }}
            >
              <FileText className="size-3 mr-1" />
              {ws ? `${fileCount} files` : "View"}
            </Button>
          );
        },
      },
      {
        key: "_actions",
        header: "Actions",
        render: (row) => (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => handleEdit(row.id)}
              title="Configure"
            >
              <Settings className="size-3.5" />
            </Button>
            {row.id !== "operator1" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-destructive hover:text-destructive"
                onClick={() => handleRemove(row.id)}
                title="Remove"
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        ),
      },
    ],
    [handleEdit, handleRemove, workspaceCache, toggleExpand],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const renderTierSection = (label: string, tierAgents: InstalledAgent[]) => {
    if (tierAgents.length === 0) {
      return null;
    }
    return (
      <section>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">{label}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tierAgents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              workspaceInfo={workspaceCache[a.id]}
              expanded={expandedAgents.has(a.id)}
              onToggleExpand={() => toggleExpand(a.id)}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onRemove={handleRemove}
              onClone={handleClone}
              onCreateSpecialist={a.tier <= 2 ? handleCreateSpecialist : undefined}
              onEditFile={handleEditFile}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agent Workspaces</h2>
          <p className="text-muted-foreground">
            {hasAgents
              ? `${agents.length} agents (${agents.filter((a) => a.status === "active").length} active)` +
                " — manage workspace files, identity, and tools"
              : "Manage your installed agents and their workspace configurations"}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <Button size="sm" onClick={() => openCreateAgent()}>
            <Plus className="size-4 mr-1" />
            Create Agent
          </Button>
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

      {/* Search & filters */}
      {hasAgents && (
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
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={filterTier}
            onChange={(e) => setFilterTier(e.target.value)}
          >
            <option value="all">All tiers</option>
            <option value="1">Tier 1 — Core</option>
            <option value="2">Tier 2 — Dept Heads</option>
            <option value="3">Tier 3 — Specialists</option>
          </select>
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
          >
            <option value="all">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      )}

      {!hasAgents && !loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
          <div className="text-center space-y-2">
            <Package className="mx-auto size-10 text-muted-foreground" />
            <h3 className="font-semibold">No agents installed</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Browse the marketplace to install agents, or create one from scratch.
            </p>
          </div>
        </div>
      ) : viewMode === "table" ? (
        <DataTable<InstalledAgent>
          columns={tableColumns}
          data={filtered}
          keyField="id"
          compact
          onRowClick={(row) => handleEdit(row.id)}
          rowClassName={(row) =>
            cn("cursor-pointer", row.status === "disabled" ? "opacity-60" : "")
          }
          emptyMessage="No agents installed"
          pageSize={20}
        />
      ) : (
        <div className="space-y-6">
          {renderTierSection("Core", tier1)}
          {renderTierSection("Department Heads", tier2)}
          {renderTierSection("Specialists", tier3)}
        </div>
      )}

      {/* File editor dialog */}
      {editingFile && (
        <FileEditorDialog
          agentId={editingFile.agentId}
          agentName={editingFile.agentName}
          fileName={editingFile.fileName}
          content={editingFile.content}
          onSave={handleSaveFile}
          onClose={() => setEditingFile(null)}
          saving={savingFile}
        />
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmLabel={confirmDialog.confirmLabel}
        variant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </div>
  );
}
