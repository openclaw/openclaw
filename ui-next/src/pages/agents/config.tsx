import {
  Settings,
  Save,
  Loader2,
  ChevronLeft,
  FileText,
  FolderOpen,
  Upload,
  CheckCircle2,
  RefreshCw,
  ArrowUpCircle,
  Brain,
  Cog,
  User,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentDetail {
  id: string;
  name: string;
  tier: number;
  role: string;
  department: string;
  version: string;
  description: string;
  capabilities: string[];
  keywords: string[];
  requires: string | null;
  model: { provider: string; primary: string; fallbacks?: string[] } | null;
  tools: { allow?: string[]; deny?: string[] } | null;
  routing_hints: { keywords?: string[]; priority?: string; preferred_for?: string[] } | null;
  limits: {
    timeout_seconds?: number;
    cost_limit_usd?: number;
    context_window_tokens?: number;
  } | null;
  identity?: { emoji?: string; theme?: string };
  skills: string[];
  promptContent: string;
}

interface WorkspaceFile {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
}

interface DeployStatus {
  deployed: boolean;
  currentVersion?: string;
  blueprintVersion?: string;
  needsUpgrade?: boolean;
}

type TabId = "prompt" | "identity" | "tools" | "workspace";

const TABS: { id: TabId; label: string }[] = [
  { id: "prompt", label: "Prompt" },
  { id: "identity", label: "Identity & Model" },
  { id: "tools", label: "Tools & Routing" },
  { id: "workspace", label: "Workspace" },
];

// ── Tier badge colors ────────────────────────────────────────────────────────

const TIER_COLORS: Record<number, string> = {
  1: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  2: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  3: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const DEPT_COLORS: Record<string, string> = {
  executive: "bg-purple-500/15 text-purple-400",
  engineering: "bg-cyan-500/15 text-cyan-400",
  operations: "bg-green-500/15 text-green-400",
  finance: "bg-amber-500/15 text-amber-400",
  marketing: "bg-pink-500/15 text-pink-400",
};

// ── Workspace Files Tab ──────────────────────────────────────────────────────

function WorkspaceTab({
  agentId,
  sendRpc,
}: {
  agentId: string;
  sendRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);

  const configId = agentId === "operator1" ? "main" : agentId;

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await sendRpc("agents.files.list", { agentId: configId })) as {
        files?: WorkspaceFile[];
        workspace?: string;
      };
      if (res?.files) {
        setFiles(res.files);
        setWorkspace(res.workspace ?? "");
      }
    } catch {
      // Workspace may not exist yet
    } finally {
      setLoading(false);
    }
  }, [sendRpc, configId]);

  const loadDeployStatus = useCallback(async () => {
    try {
      const res = (await sendRpc("agents.marketplace.health", {})) as {
        deployStatuses?: Array<{
          agentId: string;
          deployed: boolean;
          currentVersion?: string;
          blueprintVersion?: string;
          needsUpgrade?: boolean;
        }>;
      };
      const status = res?.deployStatuses?.find((s) => s.agentId === agentId);
      if (status) {
        setDeployStatus(status);
      } else {
        // No deploy status means we can check if files exist
        setDeployStatus(files.length > 0 ? { deployed: true } : { deployed: false });
      }
    } catch {
      // Health endpoint might not have deploy data
      setDeployStatus(files.length > 0 ? { deployed: true } : { deployed: false });
    }
  }, [sendRpc, agentId, files.length]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    void loadDeployStatus();
  }, [loadDeployStatus]);

  const loadFileContent = useCallback(
    async (fileName: string) => {
      try {
        const res = (await sendRpc("agents.files.get", { agentId: configId, name: fileName })) as {
          file?: { content?: string };
        };
        if (res?.file?.content !== undefined) {
          setEditContent(res.file.content);
          setEditingFile(fileName);
        }
      } catch {
        // File may not exist
      }
    },
    [sendRpc, configId],
  );

  const saveFile = useCallback(async () => {
    if (!editingFile) {
      return;
    }
    setSaving(true);
    try {
      await sendRpc("agents.files.set", {
        agentId: configId,
        name: editingFile,
        content: editContent,
      });
      setEditingFile(null);
      void loadFiles();
    } catch {
      // Save failed
    } finally {
      setSaving(false);
    }
  }, [sendRpc, configId, editingFile, editContent, loadFiles]);

  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    try {
      await sendRpc("agents.marketplace.health.fix", { agentId, fixType: "deploy-workspace" });
      await loadFiles();
      await loadDeployStatus();
    } catch {
      // Deploy failed
    } finally {
      setDeploying(false);
    }
  }, [sendRpc, agentId, loadFiles, loadDeployStatus]);

  // File editor view
  if (editingFile) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <FileText className="size-4" />
            Editing: {editingFile}
          </h3>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditingFile(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveFile} disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <Save className="size-4 mr-1" />
              )}
              Save
            </Button>
          </div>
        </div>
        <textarea
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono min-h-[400px] resize-y"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
        />
      </div>
    );
  }

  // Version & deploy status bar
  const showDeploy = !deployStatus?.deployed || deployStatus?.needsUpgrade;
  const deployLabel = !deployStatus?.deployed
    ? "Deploy"
    : deployStatus?.needsUpgrade
      ? "Upgrade"
      : null;

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center justify-between rounded-lg border border-dashed p-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {deployStatus?.deployed ? (
              <CheckCircle2 className="size-4 text-green-500" />
            ) : (
              <FolderOpen className="size-4 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">
              {deployStatus?.deployed ? "Workspace deployed" : "Workspace not deployed"}
            </span>
          </div>
          {deployStatus?.currentVersion && (
            <span className="text-xs text-muted-foreground">
              v{deployStatus.currentVersion}
              {deployStatus.needsUpgrade && deployStatus.blueprintVersion && (
                <span className="text-amber-400 ml-1">→ v{deployStatus.blueprintVersion}</span>
              )}
            </span>
          )}
          {workspace && (
            <span className="text-xs text-muted-foreground font-mono hidden lg:inline">
              {workspace}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showDeploy && deployLabel && (
            <Button size="sm" onClick={handleDeploy} disabled={deploying}>
              {deploying ? (
                <Loader2 className="size-3.5 animate-spin mr-1" />
              ) : deployStatus?.needsUpgrade ? (
                <ArrowUpCircle className="size-3.5 mr-1" />
              ) : (
                <Upload className="size-3.5 mr-1" />
              )}
              {deployLabel}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={loadFiles} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Categorized file sections */}
      {loading ? (
        <div className="flex justify-center p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : files.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
          <div className="text-center space-y-2">
            <FolderOpen className="mx-auto size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No workspace files found. Click Deploy to create workspace from blueprint.
            </p>
          </div>
        </div>
      ) : (
        <FileCategories files={files} onOpen={loadFileContent} />
      )}
    </div>
  );
}

// ── File categories ──────────────────────────────────────────────────────────

const SYSTEM_FILES = new Set([
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
]);
const USER_FILES = new Set(["USER.md"]);

function categorizeFiles(files: WorkspaceFile[]) {
  const system: WorkspaceFile[] = [];
  const user: WorkspaceFile[] = [];
  const memory: WorkspaceFile[] = [];

  for (const f of files) {
    if (SYSTEM_FILES.has(f.name)) {
      system.push(f);
    } else if (USER_FILES.has(f.name)) {
      user.push(f);
    } else if (
      f.name === "MEMORY.md" ||
      f.name.startsWith("memory/") ||
      f.name.startsWith("memory.")
    ) {
      memory.push(f);
    } else {
      // Unknown files go to user section
      user.push(f);
    }
  }

  return { system, user, memory };
}

function FileCard({ file, onOpen }: { file: WorkspaceFile; onOpen: (name: string) => void }) {
  return (
    <button
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
        file.missing ? "opacity-50 cursor-default" : "hover:bg-muted/50",
      )}
      onClick={() => !file.missing && onOpen(file.name)}
      disabled={file.missing}
    >
      <FileText className="size-4 text-muted-foreground shrink-0" />
      <div className="min-w-0">
        <span className="text-sm font-medium block truncate">{file.name}</span>
        {file.missing ? (
          <span className="text-xs text-muted-foreground">not created</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {file.size ? `${(file.size / 1024).toFixed(1)}KB` : "—"}
          </span>
        )}
      </div>
    </button>
  );
}

function FileSection({
  icon: Icon,
  title,
  description,
  files,
  onOpen,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  files: WorkspaceFile[];
  onOpen: (name: string) => void;
}) {
  if (files.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="text-xs text-muted-foreground">— {description}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {files.map((f) => (
          <FileCard key={f.name} file={f} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function FileCategories({
  files,
  onOpen,
}: {
  files: WorkspaceFile[];
  onOpen: (name: string) => void;
}) {
  const { system, user, memory } = categorizeFiles(files);
  return (
    <div className="space-y-6">
      <FileSection
        icon={Cog}
        title="System Files"
        description="Blueprint-managed, overwritten on deploy/upgrade"
        files={system}
        onOpen={onOpen}
      />
      <FileSection
        icon={User}
        title="User Files"
        description="Your custom files, never overwritten"
        files={user}
        onOpen={onOpen}
      />
      <FileSection
        icon={Brain}
        title="Memory"
        description="Agent memory and daily logs"
        files={memory}
        onOpen={onOpen}
      />
    </div>
  );
}

// ── Field helper ─────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentConfigPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("prompt");

  // Editable fields
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("");
  const [theme, setTheme] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [keywords, setKeywords] = useState("");
  const [skills, setSkills] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [modelPrimary, setModelPrimary] = useState("");
  const [modelFallbacks, setModelFallbacks] = useState("");
  const [toolsAllow, setToolsAllow] = useState("");
  const [toolsDeny, setToolsDeny] = useState("");
  const [routingKeywords, setRoutingKeywords] = useState("");
  const [routingPriority, setRoutingPriority] = useState("");
  const [limitTimeout, setLimitTimeout] = useState("");
  const [limitCost, setLimitCost] = useState("");
  const [limitTokens, setLimitTokens] = useState("");
  const [promptContent, setPromptContent] = useState("");

  const fetchAgent = useCallback(async () => {
    if (!isConnected || !agentId) {
      return;
    }
    setLoading(true);
    try {
      const res = await sendRpc("agents.marketplace.get", { agentId });
      if (res?.agent) {
        const a = res.agent as AgentDetail;
        setAgent(a);
        setName(a.name);
        setRole(a.role);
        setDescription(a.description);
        setCapabilities((a.capabilities ?? []).join(", "));
        setKeywords((a.keywords ?? []).join(", "));
        setSkills((a.skills ?? []).join(", "));
        setModelProvider(a.model?.provider ?? "");
        setModelPrimary(a.model?.primary ?? "");
        setModelFallbacks((a.model?.fallbacks ?? []).join(", "));
        setToolsAllow((a.tools?.allow ?? []).join(", "));
        setToolsDeny((a.tools?.deny ?? []).join(", "));
        setRoutingKeywords((a.routing_hints?.keywords ?? []).join(", "));
        setRoutingPriority(a.routing_hints?.priority ?? "normal");
        setLimitTimeout(a.limits?.timeout_seconds?.toString() ?? "");
        setLimitCost(a.limits?.cost_limit_usd?.toString() ?? "");
        setLimitTokens(a.limits?.context_window_tokens?.toString() ?? "");
        setPromptContent(a.promptContent ?? "");
        setEmoji(a.identity?.emoji ?? "");
        setTheme(a.identity?.theme ?? "");
      }
    } catch {
      // Agent not found
    } finally {
      setLoading(false);
    }
  }, [isConnected, agentId, sendRpc]);

  useEffect(() => {
    void fetchAgent();
  }, [fetchAgent]);

  const handleSave = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setSaving(true);
    setSaved(false);
    try {
      const splitComma = (s: string) =>
        s
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      await sendRpc("agents.marketplace.update", {
        agentId,
        name,
        role,
        description,
        capabilities: splitComma(capabilities),
        keywords: splitComma(keywords),
        skills: splitComma(skills),
        model:
          modelProvider || modelPrimary
            ? {
                provider: modelProvider || "anthropic",
                primary: modelPrimary || "claude-sonnet-4-6",
                ...(modelFallbacks ? { fallbacks: splitComma(modelFallbacks) } : {}),
              }
            : undefined,
        tools:
          toolsAllow || toolsDeny
            ? {
                ...(toolsAllow ? { allow: splitComma(toolsAllow) } : {}),
                ...(toolsDeny ? { deny: splitComma(toolsDeny) } : {}),
              }
            : undefined,
        routing_hints:
          routingKeywords || routingPriority
            ? {
                ...(routingKeywords ? { keywords: splitComma(routingKeywords) } : {}),
                ...(routingPriority ? { priority: routingPriority } : {}),
              }
            : undefined,
        limits: {
          ...(limitTimeout ? { timeout_seconds: parseInt(limitTimeout, 10) } : {}),
          ...(limitCost ? { cost_limit_usd: parseFloat(limitCost) } : {}),
          ...(limitTokens ? { context_window_tokens: parseInt(limitTokens, 10) } : {}),
        },
        promptContent,
        identity:
          emoji || theme
            ? {
                ...(emoji ? { emoji } : {}),
                ...(theme ? { theme } : {}),
              }
            : undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Save failed
    } finally {
      setSaving(false);
    }
  }, [
    agentId,
    sendRpc,
    name,
    role,
    description,
    capabilities,
    keywords,
    skills,
    modelProvider,
    modelPrimary,
    modelFallbacks,
    toolsAllow,
    toolsDeny,
    routingKeywords,
    routingPriority,
    limitTimeout,
    limitCost,
    limitTokens,
    promptContent,
    emoji,
    theme,
  ]);

  // ── Empty / loading / not found states ──────────────────────────────────────

  if (!agentId) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agent Configuration</h2>
          <p className="text-muted-foreground">Select an agent to configure</p>
        </div>
        <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
          <div className="text-center space-y-2">
            <Settings className="mx-auto size-10 text-muted-foreground" />
            <h3 className="font-semibold">No agent selected</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Choose an agent from the Installed page to edit its configuration.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">Agent Not Found</h2>
        <p className="text-muted-foreground">Agent "{agentId}" could not be loaded.</p>
        <Button variant="outline" onClick={() => navigate("/agents/installed")}>
          <ChevronLeft className="size-4 mr-1" /> Back to Agents
        </Button>
      </div>
    );
  }

  // ── Main layout ──────────────────────────────────────────────────────────────

  const tierClass = TIER_COLORS[agent.tier] ?? TIER_COLORS[3];
  const deptClass = DEPT_COLORS[agent.department] ?? "bg-slate-500/15 text-slate-400";

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between pb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/agents/installed")}>
            <ChevronLeft className="size-4" />
          </Button>
          {agent.identity?.emoji && (
            <span className="text-3xl leading-none">{agent.identity.emoji}</span>
          )}
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">{agent.name}</h2>
              <span
                className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", tierClass)}
              >
                T{agent.tier}
              </span>
              <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", deptClass)}>
                {agent.department}
              </span>
              {agent.version && (
                <span className="text-xs text-muted-foreground">v{agent.version}</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{agent.role}</p>
          </div>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving || activeTab === "workspace"}>
          {saving ? (
            <Loader2 className="size-4 animate-spin mr-1" />
          ) : saved ? (
            <CheckCircle2 className="size-4 text-green-500 mr-1" />
          ) : (
            <Save className="size-4 mr-1" />
          )}
          {saved ? "Saved" : "Save"}
        </Button>
      </div>

      {/* ── Tab bar ───────────────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b mb-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ───────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {/* Prompt tab */}
        {activeTab === "prompt" && (
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground">
                AGENT.md — System prompt for this agent
              </label>
              <span className="text-xs text-muted-foreground">
                {promptContent.length.toLocaleString()} chars
              </span>
            </div>
            <textarea
              className="flex-1 w-full rounded-lg border border-input bg-transparent px-4 py-3 text-sm font-mono resize-none min-h-[400px]"
              value={promptContent}
              onChange={(e) => setPromptContent(e.target.value)}
              placeholder="# Agent Name&#10;&#10;You are..."
              spellCheck={false}
            />
          </div>
        )}

        {/* Identity & Model tab */}
        {activeTab === "identity" && (
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="space-y-4 rounded-lg border p-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Identity
              </h3>
              <div className="space-y-3">
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Role">
                  <Input value={role} onChange={(e) => setRole(e.target.value)} />
                </Field>
                <Field label="Description">
                  <textarea
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm min-h-[80px] resize-y"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Emoji">
                    <Input
                      value={emoji}
                      onChange={(e) => setEmoji(e.target.value)}
                      placeholder="🤖"
                    />
                  </Field>
                  <Field label="Theme">
                    <Input
                      value={theme}
                      onChange={(e) => setTheme(e.target.value)}
                      placeholder="default"
                    />
                  </Field>
                </div>
              </div>
            </section>

            <div className="space-y-6">
              <section className="space-y-4 rounded-lg border p-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Model
                </h3>
                <div className="space-y-3">
                  <Field label="Provider">
                    <Input
                      value={modelProvider}
                      onChange={(e) => setModelProvider(e.target.value)}
                      placeholder="anthropic"
                    />
                  </Field>
                  <Field label="Primary Model">
                    <Input
                      value={modelPrimary}
                      onChange={(e) => setModelPrimary(e.target.value)}
                      placeholder="claude-opus-4-6"
                    />
                  </Field>
                  <Field label="Fallbacks (comma-separated)">
                    <Input
                      value={modelFallbacks}
                      onChange={(e) => setModelFallbacks(e.target.value)}
                      placeholder="claude-sonnet-4-6"
                    />
                  </Field>
                </div>
              </section>

              <section className="space-y-4 rounded-lg border p-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Limits
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Timeout (s)">
                    <Input
                      type="number"
                      value={limitTimeout}
                      onChange={(e) => setLimitTimeout(e.target.value)}
                      placeholder="300"
                    />
                  </Field>
                  <Field label="Cost (USD)">
                    <Input
                      type="number"
                      step="0.01"
                      value={limitCost}
                      onChange={(e) => setLimitCost(e.target.value)}
                      placeholder="0.50"
                    />
                  </Field>
                  <Field label="Context (tokens)">
                    <Input
                      type="number"
                      value={limitTokens}
                      onChange={(e) => setLimitTokens(e.target.value)}
                      placeholder="100000"
                    />
                  </Field>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* Tools & Routing tab */}
        {activeTab === "tools" && (
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="space-y-4 rounded-lg border p-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Tools & Skills
              </h3>
              <div className="space-y-3">
                <Field label="Tools Allow">
                  <Input
                    value={toolsAllow}
                    onChange={(e) => setToolsAllow(e.target.value)}
                    placeholder="read, write, exec"
                  />
                </Field>
                <Field label="Tools Deny">
                  <Input
                    value={toolsDeny}
                    onChange={(e) => setToolsDeny(e.target.value)}
                    placeholder="browser"
                  />
                </Field>
                <Field label="Skills">
                  <Input
                    value={skills}
                    onChange={(e) => setSkills(e.target.value)}
                    placeholder="coding-agent, github"
                  />
                </Field>
              </div>
            </section>

            <section className="space-y-4 rounded-lg border p-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Routing & Capabilities
              </h3>
              <div className="space-y-3">
                <Field label="Capabilities">
                  <Input
                    value={capabilities}
                    onChange={(e) => setCapabilities(e.target.value)}
                    placeholder="code_review, testing"
                  />
                </Field>
                <Field label="Keywords">
                  <Input
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="backend, api"
                  />
                </Field>
                <Field label="Routing Keywords">
                  <Input
                    value={routingKeywords}
                    onChange={(e) => setRoutingKeywords(e.target.value)}
                  />
                </Field>
                <Field label="Priority">
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                    value={routingPriority}
                    onChange={(e) => setRoutingPriority(e.target.value)}
                  >
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </Field>
              </div>
            </section>
          </div>
        )}

        {/* Workspace tab */}
        {activeTab === "workspace" && (
          <WorkspaceTab
            agentId={agentId}
            sendRpc={
              sendRpc as (method: string, params: Record<string, unknown>) => Promise<unknown>
            }
          />
        )}
      </div>
    </div>
  );
}
