import {
  Eye,
  FolderOpen,
  FileText,
  Save,
  Loader2,
  RefreshCw,
  Box,
  Terminal,
  Radio,
  Clock,
  Search,
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  AlertCircle,
  Info,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { OrgChart } from "@/components/agents/org-chart";
import { PersonaTab } from "@/components/agents/persona-tab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfigEditor } from "@/components/ui/custom/form";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgents } from "@/hooks/use-agents";
import {
  buildAgentHierarchy,
  flattenHierarchy,
  KNOWN_AGENT_META,
} from "@/lib/build-agent-hierarchy";
import { loadSettings, saveSettings } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";
import {
  AgentRow,
  AgentFile,
  AgentListResult,
  AgentHierarchy,
  SkillStatusEntry,
  SkillStatusReport,
  ChannelsStatusResult,
  ChannelAccount,
  CronJob,
  CronStatusResult,
} from "@/types/agents";

// --- Helpers ---

function formatFileSize(bytes?: number): string {
  if (bytes == null) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatTimeAgo(ms?: number): string {
  if (!ms) {
    return "-";
  }
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Tool definitions (categories matching old UI) ---

const TOOL_CATEGORIES: Record<string, { label: string; tools: string[] }> = {
  files: { label: "Files", tools: ["read", "write", "edit", "apply_patch", "glob", "grep"] },
  runtime: { label: "Runtime", tools: ["exec", "process"] },
  web: { label: "Web", tools: ["web_search", "web_fetch", "web_browse"] },
  memory: { label: "Memory", tools: ["memory_read", "memory_write", "memory_search"] },
  sessions: { label: "Sessions", tools: ["session_list", "session_read", "session_manage"] },
  ui: { label: "UI", tools: ["canvas", "artifacts"] },
  messaging: { label: "Messaging", tools: ["send", "reply", "poll"] },
  automation: { label: "Automation", tools: ["cron", "schedule", "webhook"] },
  nodes: { label: "Nodes", tools: ["node_invoke", "node_list"] },
  agents: { label: "Agents", tools: ["agent_spawn", "agent_message"] },
  media: { label: "Media", tools: ["media_generate", "media_edit", "tts", "stt"] },
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents",
  write: "Create or overwrite files",
  edit: "Make precise edits",
  apply_patch: "Patch files (OpenAI)",
  glob: "Search files by pattern",
  grep: "Search file contents",
  exec: "Run shell commands",
  process: "Manage background processes",
  web_search: "Search the web",
  web_fetch: "Fetch web pages",
  web_browse: "Browse web interactively",
  memory_read: "Read memory entries",
  memory_write: "Write memory entries",
  memory_search: "Search memory",
  session_list: "List sessions",
  session_read: "Read session data",
  session_manage: "Manage sessions",
  canvas: "Canvas UI",
  artifacts: "Generate artifacts",
  send: "Send messages",
  reply: "Reply to messages",
  poll: "Create polls",
  cron: "Manage cron jobs",
  schedule: "Schedule tasks",
  webhook: "Handle webhooks",
  node_invoke: "Invoke node commands",
  node_list: "List nodes",
  agent_spawn: "Spawn sub-agents",
  agent_message: "Message agents",
  media_generate: "Generate media",
  media_edit: "Edit media",
  tts: "Text to speech",
  stt: "Speech to text",
};

const TOOL_PROFILES = ["minimal", "coding", "messaging", "full", "inherit"] as const;

// ============================================================
// MAIN COMPONENT
// ============================================================

export function AgentsPage() {
  const {
    listAgents,
    listAgentFiles,
    getAgentFile,
    setAgentFile,
    getSkillsStatus,
    updateSkill,
    getChannelsStatus,
    getCronStatus,
    getCronList,
    getConfig,
  } = useAgents();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const navigate = useNavigate();

  // Core state
  const [agentListResult, setAgentListResult] = useState<AgentListResult | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [sidebarCollapsed, setSidebarCollapsedRaw] = useState(
    () => loadSettings().agentsSidebarCollapsed,
  );
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedRaw(collapsed);
    const s = loadSettings();
    s.agentsSidebarCollapsed = collapsed;
    saveSettings(s);
  }, []);

  // Hierarchy state
  const [agentHierarchy, setAgentHierarchy] = useState<AgentHierarchy | null>(null);

  // Overview state
  const [workspace, setWorkspace] = useState("");
  const [primaryModel, setPrimaryModel] = useState("");
  const [fallbackModels, setFallbackModels] = useState("");
  const [skillsFilter] = useState("all skills");

  // Files state
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<AgentFile | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [originalFileContent, setOriginalFileContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);

  // Tools state
  const [toolProfile, setToolProfile] = useState("full");
  const [toolOverrides, setToolOverrides] = useState<Record<string, boolean>>({});
  const [loadingTools, setLoadingTools] = useState(false);
  const [savingTools, setSavingTools] = useState(false);

  // Skills state
  const [skillsReport, setSkillsReport] = useState<SkillStatusReport | null>(null);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillOverrides, setSkillOverrides] = useState<Record<string, boolean>>({});
  const [savingSkills, setSavingSkills] = useState(false);

  // Channels state
  const [channelsStatus, setChannelsStatus] = useState<ChannelsStatusResult | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [channelsLastRefresh, setChannelsLastRefresh] = useState<number | null>(null);

  // Cron state
  const [cronStatus, setCronStatus] = useState<CronStatusResult | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loadingCron, setLoadingCron] = useState(false);

  // ---- Data Loading ----

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgents();
      if (result) {
        setAgentListResult(result);
        setAgents(result.agents);
        if (!selectedAgentId && result.defaultId) {
          setSelectedAgentId(result.defaultId);
        }
      }
    } catch (e) {
      console.error("Failed to list agents", e);
    } finally {
      setLoading(false);
    }
  }, [listAgents, selectedAgentId]);

  useEffect(() => {
    if (isConnected) {
      void loadAgents();
    }
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load overview data when agent changes
  const loadOverview = useCallback(async () => {
    if (!selectedAgentId) {
      return;
    }
    try {
      const configResult = await getConfig();
      if (configResult) {
        const cfg = configResult.config || {};
        const llm = cfg.llm as Record<string, unknown> | undefined;
        setPrimaryModel((llm?.model as string) || "");
        setFallbackModels(
          Array.isArray(llm?.fallbacks) ? (llm.fallbacks as string[]).join(", ") : "",
        );

        // Build agent hierarchy from config agents.list if available,
        // otherwise fall back to the agents from agents.list RPC
        const agentsCfg = cfg.agents as Record<string, unknown> | undefined;
        const agentList = agentsCfg?.list as Array<Record<string, unknown>> | undefined;

        // Use config agents.list if available (has subagents info), else build from RPC agents
        const hierarchySource: Array<Record<string, unknown>> = Array.isArray(agentList)
          ? agentList
          : agents.map((a) => ({
              id: a.id,
              name: a.name,
              identity: a.identity,
            }));

        if (hierarchySource.length > 1) {
          // Build a files map: agentId → Set of file names (for SOUL.md / IDENTITY.md detection)
          const filesMap = new Map<string, Set<string>>();
          try {
            const fileResults = await Promise.all(
              hierarchySource.map((a) => listAgentFiles(a.id as string).catch(() => null)),
            );
            for (let i = 0; i < hierarchySource.length; i++) {
              const result = fileResults[i];
              if (result?.files) {
                filesMap.set(
                  hierarchySource[i].id as string,
                  new Set(result.files.filter((f) => !f.missing).map((f) => f.name)),
                );
              }
            }
          } catch {
            // Files detection is best-effort
          }

          const hierarchy = buildAgentHierarchy(
            hierarchySource.map((a) => ({
              id: a.id as string,
              name: a.name as string | undefined,
              identity: a.identity as { emoji?: string } | undefined,
              model: a.model as string | { primary?: string } | undefined,
              role: a.role as string | undefined,
              department: a.department as string | undefined,
              subagents: a.subagents as { allowAgents?: string[] } | undefined,
            })),
            filesMap,
          );
          setAgentHierarchy(hierarchy);
        } else {
          setAgentHierarchy(null);
        }
      }
    } catch (e) {
      console.error("Failed to load config", e);
    }
  }, [selectedAgentId, getConfig, listAgentFiles]);

  // Load files
  const loadFiles = useCallback(async () => {
    if (!selectedAgentId) {
      return;
    }
    try {
      const result = await listAgentFiles(selectedAgentId);
      if (result) {
        setFiles(result.files);
        setWorkspace(result.workspace);
      }
    } catch (e) {
      console.error("Failed to list files", e);
    }
  }, [selectedAgentId, listAgentFiles]);

  // Load tools config from agents.files.get for tools.json
  const loadToolsConfig = useCallback(async () => {
    if (!selectedAgentId) {
      return;
    }
    setLoadingTools(true);
    try {
      const result = await getAgentFile(selectedAgentId, "TOOLS.md");
      if (result?.file?.content) {
        // Parse tool config - it's typically stored as JSON in a markdown wrapper or raw
        try {
          const parsed = JSON.parse(result.file.content);
          if (parsed.profile) {
            setToolProfile(parsed.profile);
          }
          if (parsed.overrides) {
            setToolOverrides(parsed.overrides);
          }
        } catch {
          // Not JSON - tools config may be in markdown format
          setToolProfile("full");
          setToolOverrides({});
        }
      }
    } catch (e) {
      console.error("Failed to load tools config", e);
    } finally {
      setLoadingTools(false);
    }
  }, [selectedAgentId, getAgentFile]);

  // Load skills
  const loadSkills = useCallback(async () => {
    if (!selectedAgentId) {
      return;
    }
    setLoadingSkills(true);
    try {
      const result = await getSkillsStatus(selectedAgentId);
      if (result) {
        setSkillsReport(result);
        // Initialize overrides from current state
        const overrides: Record<string, boolean> = {};
        for (const skill of result.skills) {
          overrides[skill.skillKey] = !skill.disabled && !skill.blockedByAllowlist;
        }
        setSkillOverrides(overrides);
      }
    } catch (e) {
      console.error("Failed to load skills", e);
    } finally {
      setLoadingSkills(false);
    }
  }, [selectedAgentId, getSkillsStatus]);

  // Load channels
  const loadChannels = useCallback(async () => {
    setLoadingChannels(true);
    try {
      const result = await getChannelsStatus();
      if (result) {
        setChannelsStatus(result);
        setChannelsLastRefresh(Date.now());
      }
    } catch (e) {
      console.error("Failed to load channels", e);
    } finally {
      setLoadingChannels(false);
    }
  }, [getChannelsStatus]);

  // Load cron
  const loadCron = useCallback(async () => {
    setLoadingCron(true);
    try {
      const [statusResult, listResult] = await Promise.all([getCronStatus(), getCronList(true)]);
      if (statusResult) {
        setCronStatus(statusResult);
      }
      if (listResult) {
        // Filter to jobs targeting this agent
        const agentJobs = listResult.jobs.filter(
          (j) => !j.agentId || j.agentId === selectedAgentId,
        );
        setCronJobs(agentJobs);
      }
    } catch (e) {
      console.error("Failed to load cron", e);
    } finally {
      setLoadingCron(false);
    }
  }, [selectedAgentId, getCronStatus, getCronList]);

  // Load data on agent select
  useEffect(() => {
    if (selectedAgentId && isConnected) {
      void loadFiles();
      void loadOverview();
    }
  }, [selectedAgentId, isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load tab-specific data on tab change
  useEffect(() => {
    if (!selectedAgentId || !isConnected) {
      return;
    }
    if (activeTab === "tools") {
      void loadToolsConfig();
    }
    if (activeTab === "skills") {
      void loadSkills();
    }
    if (activeTab === "channels") {
      void loadChannels();
    }
    if (activeTab === "cron") {
      void loadCron();
    }
  }, [activeTab, selectedAgentId, isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- File Handlers ----

  const handleFileSelect = async (file: AgentFile) => {
    if (file.missing) {
      return;
    }
    setSelectedFile(file);
    setLoadingFile(true);
    try {
      const result = await getAgentFile(selectedAgentId!, file.name);
      if (result?.file?.content !== undefined) {
        setFileContent(result.file.content);
        setOriginalFileContent(result.file.content);
      } else {
        setFileContent("");
        setOriginalFileContent("");
      }
    } catch (e) {
      console.error("Failed to get file", e);
      setFileContent("");
      setOriginalFileContent("");
    } finally {
      setLoadingFile(false);
    }
  };

  const handleSaveFile = async () => {
    if (!selectedAgentId || !selectedFile) {
      return;
    }
    setSavingFile(true);
    try {
      await setAgentFile(selectedAgentId, selectedFile.name, fileContent);
      setOriginalFileContent(fileContent);
      await loadFiles();
    } catch (e) {
      console.error("Failed to save file", e);
    } finally {
      setSavingFile(false);
    }
  };

  // ---- Tools Handlers ----

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    setToolOverrides((prev) => ({ ...prev, [toolName]: enabled }));
  };

  const handleToolProfileChange = (profile: string) => {
    setToolProfile(profile);
    // When changing profile, reset overrides
    const newOverrides: Record<string, boolean> = {};
    const allTools = Object.values(TOOL_CATEGORIES).flatMap((c) => c.tools);
    const enableAll = profile === "full";
    for (const tool of allTools) {
      newOverrides[tool] = enableAll;
    }
    setToolOverrides(newOverrides);
  };

  const handleEnableAllTools = () => {
    const newOverrides: Record<string, boolean> = {};
    for (const tool of Object.values(TOOL_CATEGORIES).flatMap((c) => c.tools)) {
      newOverrides[tool] = true;
    }
    setToolOverrides(newOverrides);
  };

  const handleDisableAllTools = () => {
    const newOverrides: Record<string, boolean> = {};
    for (const tool of Object.values(TOOL_CATEGORIES).flatMap((c) => c.tools)) {
      newOverrides[tool] = false;
    }
    setToolOverrides(newOverrides);
  };

  const handleSaveTools = async () => {
    if (!selectedAgentId) {
      return;
    }
    setSavingTools(true);
    try {
      const toolsConfig = JSON.stringify(
        { profile: toolProfile, overrides: toolOverrides },
        null,
        2,
      );
      await setAgentFile(selectedAgentId, "TOOLS.md", toolsConfig);
    } catch (e) {
      console.error("Failed to save tools config", e);
    } finally {
      setSavingTools(false);
    }
  };

  // ---- Skills Handlers ----

  const handleSkillToggle = async (skillKey: string, enabled: boolean) => {
    setSkillOverrides((prev) => ({ ...prev, [skillKey]: enabled }));
  };

  const handleSaveSkills = async () => {
    setSavingSkills(true);
    try {
      // Save each changed skill
      for (const [skillKey, enabled] of Object.entries(skillOverrides)) {
        const original = skillsReport?.skills.find((s) => s.skillKey === skillKey);
        if (original) {
          const wasEnabled = !original.disabled && !original.blockedByAllowlist;
          if (wasEnabled !== enabled) {
            await updateSkill(skillKey, { enabled });
          }
        }
      }
      await loadSkills();
    } catch (e) {
      console.error("Failed to save skills", e);
    } finally {
      setSavingSkills(false);
    }
  };

  const handleEnableAllSkills = () => {
    if (!skillsReport) {
      return;
    }
    const newOverrides: Record<string, boolean> = {};
    for (const skill of skillsReport.skills) {
      newOverrides[skill.skillKey] = true;
    }
    setSkillOverrides(newOverrides);
  };

  const handleDisableAllSkills = () => {
    if (!skillsReport) {
      return;
    }
    const newOverrides: Record<string, boolean> = {};
    for (const skill of skillsReport.skills) {
      newOverrides[skill.skillKey] = false;
    }
    setSkillOverrides(newOverrides);
  };

  // ---- Derived Data ----

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const isDefault = agentListResult?.defaultId === selectedAgentId;

  // Build a hierarchy-ordered sidebar list (depth-first) with indentation depth
  const sidebarAgents = useMemo(() => {
    if (!agentHierarchy || agentHierarchy.nodeCount <= 1) {
      // No hierarchy — fall back to flat list
      return agents.map((a) => ({ agent: a, depth: 0 }));
    }
    const ordered = flattenHierarchy(agentHierarchy);
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    return ordered
      .map((entry) => ({ agent: agentMap.get(entry.agentId), depth: entry.depth }))
      .filter((e): e is { agent: AgentRow; depth: number } => e.agent != null);
  }, [agents, agentHierarchy]);

  const enabledToolCount = Object.values(toolOverrides).filter(Boolean).length;
  const totalToolCount = Object.values(TOOL_CATEGORIES).reduce((sum, c) => sum + c.tools.length, 0);

  const filteredSkills =
    skillsReport?.skills.filter(
      (s) =>
        !skillSearch ||
        s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
        s.description.toLowerCase().includes(skillSearch.toLowerCase()),
    ) ?? [];

  const enabledSkillCount = Object.values(skillOverrides).filter(Boolean).length;
  const totalSkillCount = skillsReport?.skills.length ?? 0;

  const skillsBySource = filteredSkills.reduce<Record<string, SkillStatusEntry[]>>((acc, skill) => {
    const key = skill.source || "unknown";
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(skill);
    return acc;
  }, {});

  // ---- Render ----

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Agents</h1>
          {agents.length > 0 && (
            <span className="text-sm text-muted-foreground ml-1">{agents.length} configured.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/visualize")}>
            <Eye className="mr-1 h-4 w-4" /> Visualize
          </Button>
          <Button variant="outline" size="sm" onClick={loadAgents} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: Agent List (collapsible) */}
        <div
          className={cn(
            "border-r bg-muted/10 flex flex-col shrink-0 transition-all duration-200 ease-in-out",
            sidebarCollapsed ? "w-[56px]" : "w-[250px]",
          )}
        >
          {/* Sidebar header with collapse toggle */}
          <div
            className={cn(
              "flex items-center border-b px-2 py-3",
              sidebarCollapsed ? "justify-center" : "justify-between px-4",
            )}
          >
            {!sidebarCollapsed && (
              <span className="text-sm font-medium text-muted-foreground">Workspaces</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? (
                <ChevronsRight className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronsLeft className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>

          {/* Agent list */}
          <ScrollArea className="flex-1">
            <div className={cn("space-y-0.5", sidebarCollapsed ? "p-1.5" : "p-2")}>
              {sidebarAgents.map(({ agent, depth }) => (
                <div key={agent.id} className="relative group">
                  <button
                    onClick={() => {
                      setSelectedAgentId(agent.id);
                      setSelectedFile(null);
                      setFileContent("");
                      setOriginalFileContent("");
                    }}
                    className={cn(
                      "flex w-full items-center rounded-md transition-colors hover:bg-muted",
                      sidebarCollapsed ? "justify-center px-0 py-2" : "gap-2.5 py-1.5 text-sm",
                      selectedAgentId === agent.id
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground",
                    )}
                    style={
                      !sidebarCollapsed
                        ? { paddingLeft: `${12 + depth * 16}px`, paddingRight: 12 }
                        : undefined
                    }
                  >
                    <div
                      className={cn(
                        "flex items-center justify-center rounded-full bg-background border shadow-sm shrink-0",
                        sidebarCollapsed ? "h-9 w-9" : "h-7 w-7",
                      )}
                    >
                      {agent.identity?.emoji ? (
                        <span className={sidebarCollapsed ? "text-base" : "text-xs"}>
                          {agent.identity.emoji}
                        </span>
                      ) : (
                        <Box className="h-3.5 w-3.5" />
                      )}
                    </div>
                    {!sidebarCollapsed && (
                      <>
                        <div className="flex-1 text-left min-w-0">
                          <div className="truncate text-xs">{agent.name || agent.id}</div>
                        </div>
                        {agentListResult?.defaultId === agent.id && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                            DEFAULT
                          </Badge>
                        )}
                      </>
                    )}
                  </button>
                  {/* Tooltip on collapsed hover */}
                  {sidebarCollapsed && (
                    <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:block">
                      <div className="rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md whitespace-nowrap">
                        <span className="font-medium">{agent.name || agent.id}</span>
                        {agentListResult?.defaultId === agent.id && (
                          <span className="ml-2 text-[10px] text-muted-foreground">DEFAULT</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Main Content */}
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
          {selectedAgent ? (
            <>
              {/* Agent Header */}
              <div className="flex items-center justify-between border-b px-6 py-4 bg-background">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/5 border">
                    {selectedAgent.identity?.emoji ? (
                      <span className="text-2xl">{selectedAgent.identity.emoji}</span>
                    ) : (
                      <Box className="h-6 w-6 text-primary" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold">
                        {selectedAgent.name || selectedAgent.id}
                      </h2>
                      {isDefault && (
                        <Badge variant="outline" className="text-xs">
                          DEFAULT
                        </Badge>
                      )}
                    </div>
                    {(() => {
                      const meta = KNOWN_AGENT_META[selectedAgent.id];
                      const role = selectedAgent.role ?? meta?.role;
                      const dept = selectedAgent.department ?? meta?.department;
                      return (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span className="font-mono">{selectedAgent.id}</span>
                          {role && (
                            <>
                              <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                              <span className="font-medium text-primary/80">{role}</span>
                            </>
                          )}
                          {dept && (
                            <>
                              <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                              <span className="capitalize">{dept}</span>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Org Chart */}
              {agentHierarchy && (
                <div className="px-6 pt-4">
                  <OrgChart
                    hierarchy={agentHierarchy}
                    selectedAgentId={selectedAgentId}
                    onSelect={(agentId) => {
                      setSelectedAgentId(agentId);
                      setSelectedFile(null);
                      setFileContent("");
                      setOriginalFileContent("");
                    }}
                    onEdit={(agentId) => {
                      setSelectedAgentId(agentId);
                      setSelectedFile(null);
                      setFileContent("");
                      setOriginalFileContent("");
                      setActiveTab("persona");
                    }}
                  />
                </div>
              )}

              {/* Tabs */}
              <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex-1 flex flex-col overflow-hidden"
              >
                <div className="border-b px-6">
                  <TabsList className="bg-transparent h-12">
                    <TabsTrigger
                      value="overview"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Overview
                    </TabsTrigger>
                    <TabsTrigger
                      value="persona"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Persona
                    </TabsTrigger>
                    <TabsTrigger
                      value="files"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Files
                    </TabsTrigger>
                    <TabsTrigger
                      value="tools"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Tools
                    </TabsTrigger>
                    <TabsTrigger
                      value="skills"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Skills
                    </TabsTrigger>
                    <TabsTrigger
                      value="channels"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Channels
                    </TabsTrigger>
                    <TabsTrigger
                      value="cron"
                      className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-4 h-full"
                    >
                      Cron Jobs
                    </TabsTrigger>
                  </TabsList>
                </div>

                <div className="flex-1 overflow-auto bg-muted/5 p-6">
                  {/* ========== OVERVIEW TAB ========== */}
                  <TabsContent value="overview" className="m-0 border-none">
                    <div className="space-y-6 max-w-4xl">
                      {/* Overview header */}
                      <div>
                        <h3 className="text-lg font-semibold mb-1">Overview</h3>
                        <p className="text-sm text-muted-foreground">
                          Workspace paths and identity metadata.
                        </p>
                      </div>

                      {/* Metadata grid */}
                      <div className="rounded-lg border bg-card p-5">
                        <div className="grid grid-cols-3 gap-6 text-sm">
                          <div>
                            <span className="text-muted-foreground block mb-1">Workspace</span>
                            <span className="font-mono text-xs">{workspace || "default"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Primary Model</span>
                            <span className="font-mono">{primaryModel || "-"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Identity Name</span>
                            <span>{selectedAgent.identity?.name || "Assistant"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Role</span>
                            {(() => {
                              const r =
                                selectedAgent.role ?? KNOWN_AGENT_META[selectedAgent.id]?.role;
                              return <span className={r ? "font-medium" : ""}>{r || "-"}</span>;
                            })()}
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Department</span>
                            {(() => {
                              const d =
                                selectedAgent.department ??
                                KNOWN_AGENT_META[selectedAgent.id]?.department;
                              return <span className="capitalize">{d || "-"}</span>;
                            })()}
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Default</span>
                            <span>{isDefault ? "yes" : "no"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Identity Emoji</span>
                            <span>{selectedAgent.identity?.emoji || "-"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Skills Filter</span>
                            <span>{skillsFilter}</span>
                          </div>
                        </div>
                      </div>

                      {/* Model Selection */}
                      <div className="rounded-lg border bg-card p-5">
                        <h4 className="font-medium mb-4">Model Selection</h4>
                        <div className="grid grid-cols-2 gap-6">
                          <div>
                            <label className="text-sm text-muted-foreground block mb-2">
                              Primary model (default)
                            </label>
                            <input
                              type="text"
                              value={primaryModel}
                              onChange={(e) => setPrimaryModel(e.target.value)}
                              placeholder="provider/model"
                              className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                          </div>
                          <div>
                            <label className="text-sm text-muted-foreground block mb-2">
                              Fallbacks (comma-separated)
                            </label>
                            <input
                              type="text"
                              value={fallbackModels}
                              onChange={(e) => setFallbackModels(e.target.value)}
                              placeholder="provider/model, provider/model"
                              className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                          </div>
                        </div>
                        <div className="flex justify-end gap-2 mt-4">
                          <Button variant="outline" size="sm" onClick={loadOverview}>
                            Reload Config
                          </Button>
                          <Button size="sm" className="bg-primary">
                            <Save className="h-3.5 w-3.5 mr-2" />
                            Save
                          </Button>
                        </div>
                      </div>
                    </div>
                  </TabsContent>

                  {/* ========== PERSONA TAB ========== */}
                  <TabsContent value="persona" className="m-0 border-none">
                    {selectedAgentId && (
                      <PersonaTab
                        agentId={selectedAgentId}
                        getAgentFile={getAgentFile}
                        setAgentFile={setAgentFile}
                      />
                    )}
                  </TabsContent>

                  {/* ========== FILES TAB ========== */}
                  <TabsContent value="files" className="h-full m-0 border-none flex gap-4">
                    {/* File List */}
                    <div className="w-72 flex-shrink-0 rounded-lg border bg-card flex flex-col">
                      <div className="p-3 border-b bg-muted/20 flex items-center justify-between">
                        <div>
                          <div className="font-medium text-sm">Core Files</div>
                          <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-[200px]">
                            {workspace ? `Workspace: ${workspace}` : ""}
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadFiles}>
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <ScrollArea className="flex-1">
                        <div className="p-2 space-y-0.5">
                          {files.map((file) => (
                            <button
                              key={file.name}
                              onClick={() => handleFileSelect(file)}
                              disabled={file.missing}
                              className={cn(
                                "flex w-full items-center gap-2 rounded px-2.5 py-2 text-sm transition-colors text-left",
                                selectedFile?.name === file.name
                                  ? "bg-primary/10 text-primary font-medium"
                                  : file.missing
                                    ? "text-muted-foreground/50 cursor-not-allowed"
                                    : "hover:bg-muted text-muted-foreground",
                              )}
                            >
                              <FileText className="h-4 w-4 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="truncate font-mono text-xs">{file.name}</div>
                                {!file.missing && (
                                  <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                                    {formatFileSize(file.size)} · {formatTimeAgo(file.updatedAtMs)}
                                  </div>
                                )}
                              </div>
                              {file.missing && (
                                <Badge
                                  variant="destructive"
                                  className="text-[10px] px-1 py-0 h-4 shrink-0"
                                >
                                  Missing
                                </Badge>
                              )}
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>

                    {/* Editor */}
                    <div className="flex-1 rounded-lg border bg-card flex flex-col overflow-hidden">
                      {selectedFile ? (
                        <>
                          <div className="flex items-center justify-between p-3 border-b bg-muted/20">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm font-medium">
                                {selectedFile.name}
                              </span>
                              {fileContent !== originalFileContent && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0 text-chart-5 border-chart-5/30"
                                >
                                  modified
                                </Badge>
                              )}
                            </div>
                            <Button
                              size="sm"
                              onClick={handleSaveFile}
                              disabled={
                                savingFile || loadingFile || fileContent === originalFileContent
                              }
                              className="h-7"
                            >
                              {savingFile ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                              ) : (
                                <Save className="h-3.5 w-3.5 mr-2" />
                              )}
                              Save
                            </Button>
                          </div>
                          <div className="flex-1 relative">
                            {loadingFile ? (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                              </div>
                            ) : (
                              <ConfigEditor
                                value={fileContent}
                                onChange={setFileContent}
                                language={selectedFile.name.endsWith(".json") ? "json" : "yaml"}
                                className="h-full w-full border-0"
                              />
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                          <Terminal className="h-12 w-12 mb-4 opacity-20" />
                          <p>Select a file to edit</p>
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  {/* ========== TOOLS TAB ========== */}
                  <TabsContent value="tools" className="m-0 border-none">
                    <div className="space-y-6 max-w-4xl">
                      {/* Header */}
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="text-lg font-semibold mb-1">Tool Access</h3>
                          <p className="text-sm text-muted-foreground">
                            Profile + per-tool overrides for this agent. {enabledToolCount}/
                            {totalToolCount} enabled.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={handleEnableAllTools}>
                            Enable All
                          </Button>
                          <Button variant="outline" size="sm" onClick={handleDisableAllTools}>
                            Disable All
                          </Button>
                          <Button variant="outline" size="sm" onClick={loadToolsConfig}>
                            Reload Config
                          </Button>
                          <Button size="sm" onClick={handleSaveTools} disabled={savingTools}>
                            {savingTools && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
                            <Save className="h-3.5 w-3.5 mr-2" />
                            Save
                          </Button>
                        </div>
                      </div>

                      {/* Profile info */}
                      <div className="rounded-lg border bg-card p-5">
                        <div className="grid grid-cols-2 gap-6 text-sm mb-4">
                          <div>
                            <span className="text-muted-foreground block mb-1">Profile</span>
                            <span className="font-semibold">{toolProfile}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block mb-1">Source</span>
                            <span>default</span>
                          </div>
                        </div>

                        {/* Quick Presets */}
                        <div>
                          <span className="text-sm text-muted-foreground block mb-2">
                            Quick Presets
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {TOOL_PROFILES.map((profile) => (
                              <Button
                                key={profile}
                                variant={toolProfile === profile ? "default" : "outline"}
                                size="sm"
                                onClick={() => handleToolProfileChange(profile)}
                                className="capitalize"
                              >
                                {profile}
                              </Button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Tool categories */}
                      {loadingTools ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                      ) : (
                        Object.entries(TOOL_CATEGORIES).map(([catKey, cat]) => (
                          <div key={catKey} className="rounded-lg border bg-card p-5">
                            <h4 className="font-medium mb-3">{cat.label}</h4>
                            <div className="grid grid-cols-2 gap-3">
                              {cat.tools.map((tool) => (
                                <div
                                  key={tool}
                                  className="flex items-center justify-between rounded-md border px-3 py-2.5"
                                >
                                  <div>
                                    <div className="text-sm font-medium">{tool}</div>
                                    <div className="text-xs text-muted-foreground">
                                      {TOOL_DESCRIPTIONS[tool] || tool}
                                    </div>
                                  </div>
                                  <Switch
                                    checked={toolOverrides[tool]}
                                    onCheckedChange={(checked) => handleToolToggle(tool, checked)}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </TabsContent>

                  {/* ========== SKILLS TAB ========== */}
                  <TabsContent value="skills" className="m-0 border-none">
                    <div className="space-y-6 max-w-4xl">
                      {/* Header */}
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="text-lg font-semibold mb-1">Skills</h3>
                          <p className="text-sm text-muted-foreground">
                            Per-agent skill allowlist and workspace skills. {enabledSkillCount}/
                            {totalSkillCount}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={handleEnableAllSkills}>
                            Use All
                          </Button>
                          <Button variant="outline" size="sm" onClick={handleDisableAllSkills}>
                            Disable All
                          </Button>
                          <Button variant="outline" size="sm" onClick={loadSkills}>
                            <RefreshCw
                              className={cn("h-3.5 w-3.5 mr-2", loadingSkills && "animate-spin")}
                            />
                            Refresh
                          </Button>
                          <Button size="sm" onClick={handleSaveSkills} disabled={savingSkills}>
                            {savingSkills && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
                            <Save className="h-3.5 w-3.5 mr-2" />
                            Save
                          </Button>
                        </div>
                      </div>

                      {/* Info banner */}
                      {enabledSkillCount === totalSkillCount && totalSkillCount > 0 && (
                        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex items-start gap-3">
                          <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                          <p className="text-sm text-primary">
                            All skills are enabled. Disabling any skill will create a per-agent
                            allowlist.
                          </p>
                        </div>
                      )}

                      {/* Search */}
                      <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <input
                            type="text"
                            value={skillSearch}
                            onChange={(e) => setSkillSearch(e.target.value)}
                            placeholder="Search skills"
                            className="w-full rounded-md border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </div>
                        <span className="text-sm text-muted-foreground whitespace-nowrap">
                          {filteredSkills.length} shown
                        </span>
                      </div>

                      {/* Skills by source */}
                      {loadingSkills ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                      ) : (
                        Object.entries(skillsBySource).map(([source, skills]) => (
                          <SkillSourceGroup
                            key={source}
                            source={source}
                            skills={skills}
                            overrides={skillOverrides}
                            onToggle={handleSkillToggle}
                          />
                        ))
                      )}

                      {!loadingSkills && filteredSkills.length === 0 && (
                        <div className="text-center py-12 text-muted-foreground">
                          No skills found.
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  {/* ========== CHANNELS TAB ========== */}
                  <TabsContent value="channels" className="m-0 border-none">
                    <div className="space-y-6 max-w-5xl">
                      <div className="grid grid-cols-2 gap-6">
                        {/* Agent Context */}
                        <div className="rounded-lg border bg-card p-5">
                          <h3 className="text-lg font-semibold mb-1">Agent Context</h3>
                          <p className="text-sm text-muted-foreground mb-4">
                            Workspace, identity, and model configuration.
                          </p>
                          <div className="space-y-3 text-sm">
                            <div>
                              <span className="text-muted-foreground block mb-0.5">Workspace</span>
                              <span className="font-mono text-xs">{workspace || "default"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Primary Model
                              </span>
                              <span className="font-mono">{primaryModel || "-"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Identity Name
                              </span>
                              <span>{selectedAgent.identity?.name || "Assistant"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Identity Emoji
                              </span>
                              <span>{selectedAgent.identity?.emoji || "-"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Skills Filter
                              </span>
                              <span>{skillsFilter}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">Default</span>
                              <span>{isDefault ? "yes" : "no"}</span>
                            </div>
                          </div>
                        </div>

                        {/* Channels Status */}
                        <div className="rounded-lg border bg-card p-5">
                          <div className="flex items-start justify-between mb-1">
                            <h3 className="text-lg font-semibold">Channels</h3>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={loadChannels}
                              disabled={loadingChannels}
                            >
                              <RefreshCw
                                className={cn(
                                  "h-3.5 w-3.5 mr-2",
                                  loadingChannels && "animate-spin",
                                )}
                              />
                              Refresh
                            </Button>
                          </div>
                          <p className="text-sm text-muted-foreground mb-1">
                            Gateway-wide channel status snapshot.
                          </p>
                          {channelsLastRefresh && (
                            <p className="text-xs text-muted-foreground mb-4">
                              Last refresh: {formatTimeAgo(channelsLastRefresh)}
                            </p>
                          )}

                          {loadingChannels ? (
                            <div className="flex items-center justify-center py-8">
                              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                          ) : channelsStatus ? (
                            <div className="space-y-3">
                              {channelsStatus.channelOrder.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No channels found.</p>
                              ) : (
                                channelsStatus.channelOrder.map((channelId) => {
                                  const label =
                                    channelsStatus.channelLabels[channelId] || channelId;
                                  const accounts = channelsStatus.channelAccounts[channelId] || [];
                                  return (
                                    <ChannelCard
                                      key={channelId}
                                      channelId={channelId}
                                      label={label}
                                      accounts={accounts}
                                    />
                                  );
                                })
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">No channels found.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </TabsContent>

                  {/* ========== CRON JOBS TAB ========== */}
                  <TabsContent value="cron" className="m-0 border-none">
                    <div className="space-y-6 max-w-5xl">
                      <div className="grid grid-cols-2 gap-6">
                        {/* Agent Context */}
                        <div className="rounded-lg border bg-card p-5">
                          <h3 className="text-lg font-semibold mb-1">Agent Context</h3>
                          <p className="text-sm text-muted-foreground mb-4">
                            Workspace and scheduling targets.
                          </p>
                          <div className="space-y-3 text-sm">
                            <div>
                              <span className="text-muted-foreground block mb-0.5">Workspace</span>
                              <span className="font-mono text-xs">{workspace || "default"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Primary Model
                              </span>
                              <span className="font-mono">{primaryModel || "-"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Identity Name
                              </span>
                              <span>{selectedAgent.identity?.name || "Assistant"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Identity Emoji
                              </span>
                              <span>{selectedAgent.identity?.emoji || "-"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">
                                Skills Filter
                              </span>
                              <span>{skillsFilter}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block mb-0.5">Default</span>
                              <span>{isDefault ? "yes" : "no"}</span>
                            </div>
                          </div>
                        </div>

                        {/* Scheduler Status */}
                        <div className="rounded-lg border bg-card p-5">
                          <div className="flex items-start justify-between mb-1">
                            <h3 className="text-lg font-semibold">Scheduler</h3>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={loadCron}
                              disabled={loadingCron}
                            >
                              <RefreshCw
                                className={cn("h-3.5 w-3.5 mr-2", loadingCron && "animate-spin")}
                              />
                              Refresh
                            </Button>
                          </div>
                          <p className="text-sm text-muted-foreground mb-4">Gateway cron status.</p>

                          {loadingCron ? (
                            <div className="flex items-center justify-center py-8">
                              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                          ) : cronStatus ? (
                            <div className="space-y-3">
                              <div className="rounded-md border p-4">
                                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                                  Enabled
                                </div>
                                <div className="text-2xl font-bold">
                                  {cronStatus.enabled ? "Yes" : "No"}
                                </div>
                              </div>
                              <div className="rounded-md border p-4">
                                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                                  Jobs
                                </div>
                                <div className="text-2xl font-bold">{cronStatus.jobs}</div>
                              </div>
                              <div className="rounded-md border p-4">
                                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                                  Next Wake
                                </div>
                                <div className="text-2xl font-bold">
                                  {cronStatus.nextWakeAtMs
                                    ? new Date(cronStatus.nextWakeAtMs).toLocaleTimeString()
                                    : "n/a"}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              Unable to load scheduler status.
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Agent Cron Jobs */}
                      <div className="rounded-lg border bg-card p-5">
                        <h3 className="text-lg font-semibold mb-1">Agent Cron Jobs</h3>
                        <p className="text-sm text-muted-foreground mb-4">
                          Scheduled jobs targeting this agent.
                        </p>

                        {loadingCron ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        ) : cronJobs.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No jobs assigned.</p>
                        ) : (
                          <div className="space-y-2">
                            {cronJobs.map((job) => (
                              <CronJobCard key={job.id} job={job} />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </TabsContent>
                </div>
              </Tabs>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <FolderOpen className="h-16 w-16 mb-4 opacity-20" />
              <p>Select an agent to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function SkillSourceGroup({
  source,
  skills,
  overrides,
  onToggle,
}: {
  source: string;
  skills: SkillStatusEntry[];
  overrides: Record<string, boolean>;
  onToggle: (key: string, enabled: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const sourceLabel = source.toUpperCase().replace(/-/g, " ") + " SKILLS";

  return (
    <div className="rounded-lg border bg-card">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between p-4 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {sourceLabel}
          </span>
        </div>
        <span className="text-sm text-muted-foreground">{skills.length}</span>
      </button>

      {!collapsed && (
        <div className="border-t px-4 pb-3">
          {skills.map((skill) => {
            const enabled =
              overrides[skill.skillKey] ?? (!skill.disabled && !skill.blockedByAllowlist);
            const hasMissing =
              skill.missing.bins.length > 0 ||
              skill.missing.env.length > 0 ||
              skill.missing.config.length > 0;

            return (
              <div
                key={skill.skillKey}
                className="flex items-center justify-between py-2.5 border-b border-border/50 last:border-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {skill.emoji && <span className="text-base">{skill.emoji}</span>}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{skill.name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-md">
                      {skill.description}
                    </div>
                    {hasMissing && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <AlertCircle className="h-3 w-3 text-chart-5" />
                        <span className="text-[10px] text-chart-5">
                          Missing:{" "}
                          {[
                            ...skill.missing.bins,
                            ...skill.missing.env,
                            ...skill.missing.config,
                          ].join(", ")}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => onToggle(skill.skillKey, checked)}
                  disabled={!skill.eligible && !enabled}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChannelCard({
  channelId: _channelId,
  label,
  accounts,
}: {
  channelId: string;
  label: string;
  accounts: ChannelAccount[];
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{label}</span>
        </div>
        <Badge
          variant={accounts.some((a) => a.connected) ? "default" : "outline"}
          className="text-[10px]"
        >
          {accounts.some((a) => a.connected) ? "Connected" : "Disconnected"}
        </Badge>
      </div>
      {accounts.length > 0 ? (
        <div className="space-y-1.5">
          {accounts.map((account) => (
            <div
              key={account.accountId}
              className="text-xs text-muted-foreground flex items-center gap-2"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  account.connected ? "bg-primary" : "bg-muted-foreground/30",
                )}
              />
              <span className="font-mono">{account.accountId}</span>
              {account.name && <span>({account.name})</span>}
              {account.mode && (
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-3.5">
                  {account.mode}
                </Badge>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No accounts configured.</p>
      )}
    </div>
  );
}

function CronJobCard({ job }: { job: CronJob }) {
  const scheduleLabel = (() => {
    const s = job.schedule;
    if (s.kind === "cron") {
      return s.expr;
    }
    if (s.kind === "every") {
      return `every ${Math.round(s.everyMs / 1000)}s`;
    }
    if (s.kind === "at") {
      return `at ${s.at}`;
    }
    return "unknown";
  })();

  return (
    <div className="rounded-md border p-3 flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{job.name}</span>
          {!job.enabled && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
              disabled
            </Badge>
          )}
        </div>
        {job.description && (
          <p className="text-xs text-muted-foreground ml-6 mt-0.5">{job.description}</p>
        )}
        <div className="text-xs text-muted-foreground ml-6 mt-1 flex items-center gap-3">
          <span className="font-mono">{scheduleLabel}</span>
          {job.state?.lastStatus && (
            <Badge
              variant={job.state.lastStatus === "ok" ? "default" : "destructive"}
              className="text-[10px] px-1 py-0 h-3.5"
            >
              {job.state.lastStatus}
            </Badge>
          )}
          {job.state?.nextRunAtMs && (
            <span>Next: {new Date(job.state.nextRunAtMs).toLocaleTimeString()}</span>
          )}
        </div>
      </div>
    </div>
  );
}
