import {
  Brain,
  Database,
  FileText,
  Search,
  Activity,
  RefreshCw,
  Loader2,
  Save,
  Undo2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HardDrive,
  Layers,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Info,
  Plus,
  X,
  Filter,
  Trash2,
  Download,
  Upload,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, Component } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import { StatCard } from "@/components/ui/custom/status/stat-card";
import { HighlightText } from "@/components/ui/highlight-text";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgents } from "@/hooks/use-agents";
import { useMemory } from "@/hooks/use-memory";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";
import {
  useMemoryStore,
  type MemorySearchResultUI,
  type ActivityEntry,
  type ActivityFilter,
} from "@/store/memory-store";

// --- Error Boundary ---

class FilesTabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <AlertCircle className="size-10 opacity-40 text-red-400" />
          <p className="text-sm">Failed to load files</p>
          <p className="text-xs text-center max-w-xs opacity-70">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-xs text-primary hover:underline mt-1"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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

function formatTimestamp(ms: number): string {
  if (!ms) {
    return "-";
  }
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreBadgeColor(score: number): string {
  if (score >= 0.8) {
    return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
  }
  if (score >= 0.5) {
    return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  }
  return "bg-muted text-muted-foreground";
}

/** Display-friendly name for memory files: strip "memory/" prefix, format dates */
function memoryDisplayName(name: string): string {
  if (!name.startsWith("memory/")) {
    return name;
  }
  const basename = name.slice("memory/".length);
  // Try to format YYYY-MM-DD.md as a readable date
  const dateMatch = basename.match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (dateMatch) {
    const date = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return basename;
}

const IDENTITY_COLLAPSED_KEY = "openclaw.memory.identityCollapsed";
const MEMORY_SHOW_ALL_KEY = "openclaw.memory.showAllMemory";
const MEMORY_TRUNCATE_LIMIT = 10;

function operationBadgeColor(op: ActivityEntry["operation"]): string {
  switch (op) {
    case "search":
      return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    case "read":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    case "write":
      return "bg-orange-500/20 text-orange-400 border-orange-500/30";
    case "edit":
      return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    default:
      return "bg-muted text-muted-foreground";
  }
}

// --- Disconnected state ---

function DisconnectedMessage() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
      <Brain className="size-10 opacity-40" />
      <p className="text-sm">Connect to the gateway to view memory</p>
    </div>
  );
}

// --- Health detection ---

type HealthIssue = { level: "warning" | "error"; message: string };

function detectMemoryIssues(
  indexStatus: import("@/store/memory-store").MemoryProviderStatusUI | null,
  embeddingOk: boolean,
  embeddingError: string | null,
  healthy: boolean,
): HealthIssue[] {
  const issues: HealthIssue[] = [];

  if (!indexStatus) {
    return issues;
  }

  const isQmd = indexStatus.backend === "qmd";

  // Embedding probe failure — hard error
  if (!embeddingOk || embeddingError) {
    issues.push({
      level: "error",
      message: embeddingError
        ? `Embedding probe failed: ${embeddingError}`
        : "Embedding probe returned unhealthy",
    });
  }

  // Fallback active — warning
  if (indexStatus.fallback) {
    const reason = indexStatus.fallback.reason ? `: ${indexStatus.fallback.reason}` : "";
    issues.push({
      level: "warning",
      message: `Fell back from ${indexStatus.fallback.from}${reason}`,
    });
  }

  // Batch failures — warning
  if ((indexStatus.batch?.failures ?? 0) > 0) {
    issues.push({
      level: "warning",
      message: `Batch indexing had ${indexStatus.batch!.failures} failure(s)`,
    });
  }

  // Vector unavailable (non-QMD) — warning
  if (!isQmd && indexStatus.vector && !indexStatus.vector.available) {
    const err = indexStatus.vector.loadError ? `: ${indexStatus.vector.loadError}` : "";
    issues.push({ level: "warning", message: `Vector search unavailable${err}` });
  }

  // FTS unavailable (non-QMD) — info-level warning
  if (!isQmd && indexStatus.fts && !indexStatus.fts.available) {
    const err = indexStatus.fts.error ? `: ${indexStatus.fts.error}` : "";
    issues.push({ level: "warning", message: `Full-text search unavailable${err}` });
  }

  // No indexed files — warning (not error; may just be empty workspace)
  const fileCount = indexStatus.files ?? 0;
  if (fileCount === 0) {
    issues.push({
      level: "warning",
      message: isQmd
        ? "No documents indexed (stats may be unavailable — try Re-index)"
        : "No memory files indexed yet",
    });
  }

  // Gateway says healthy but we found issues → suppress "healthy" from gateway as the sole signal
  // (gateway healthy flag = manager initialized, not "all subsystems ok")
  void healthy; // intentionally unused — we compute state from issues array

  return issues;
}

// --- Index Status Tab ---

function IndexStatusTab() {
  const {
    indexStatus,
    indexLoading,
    reindexing,
    embeddingOk,
    embeddingError,
    healthy,
    healthScore,
  } = useMemoryStore();
  const { getMemoryStatus, reindexMemory } = useMemory();

  const handleReindex = async () => {
    await reindexMemory();
    await getMemoryStatus();
  };

  const isQmd = indexStatus?.backend === "qmd";

  const issues = detectMemoryIssues(indexStatus, embeddingOk, embeddingError, healthy);
  const hasErrors = issues.some((i) => i.level === "error");
  const hasWarnings = issues.some((i) => i.level === "warning");
  const fileCount = indexStatus?.files ?? 0;

  // Derive health badge from issues (not from gateway's `healthy` flag alone)
  let healthColor: string;
  let healthLabel: string;
  let healthIcon: React.ReactNode;

  if (!indexStatus) {
    healthColor = "bg-muted/50 text-muted-foreground border-border";
    healthLabel = "Unknown";
    healthIcon = <AlertCircle className="size-3.5" />;
  } else if (hasErrors) {
    healthColor = "bg-red-500/20 text-red-400 border-red-500/30";
    healthLabel = "Unavailable";
    healthIcon = <AlertCircle className="size-3.5" />;
  } else if (fileCount === 0) {
    healthColor = "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    healthLabel = "Empty";
    healthIcon = <AlertTriangle className="size-3.5" />;
  } else if (hasWarnings) {
    healthColor = "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    healthLabel = "Degraded";
    healthIcon = <AlertTriangle className="size-3.5" />;
  } else {
    healthColor = "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    healthLabel = "Healthy";
    healthIcon = <CheckCircle2 className="size-3.5" />;
  }

  if (indexLoading && !indexStatus) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Source counts for table
  const sourceCounts = indexStatus?.sourceCounts ?? [];
  const sourceColumns: Column<Record<string, unknown>>[] = [
    { key: "source", header: "Source", sortable: true },
    { key: "files", header: "Files", sortable: true },
    { key: "chunks", header: "Chunks", sortable: true },
  ];
  const sourceData = sourceCounts.map((s) => ({
    source: s.source,
    files: s.files,
    chunks: s.chunks,
  }));

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge
          variant="outline"
          className={cn("gap-1.5 px-2.5 py-1 text-xs font-mono", healthColor)}
        >
          {healthIcon}
          {healthLabel}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReindex}
          disabled={reindexing}
          className="gap-1.5"
        >
          {reindexing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {reindexing ? "Re-indexing..." : "Re-index Now"}
        </Button>
        {indexLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* Stale index warning banner */}
      {indexStatus?.dirty && (
        <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-xs text-yellow-400">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span>Index has pending changes and may return stale results.</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reindexMemory()}
            disabled={reindexing}
            className="h-6 text-[10px] gap-1 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
          >
            {reindexing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Re-index
          </Button>
        </div>
      )}

      {/* Stat cards — backend-adaptive */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {isQmd ? (
          <>
            <StatCard
              icon={<FileText className="size-4" />}
              label="Documents"
              value={String(indexStatus?.files ?? 0)}
              subtitle={indexStatus?.dirty ? "Index has pending changes" : undefined}
            />
            <StatCard
              icon={<FolderOpen className="size-4" />}
              label="Collections"
              value={String(
                (indexStatus?.custom as Record<string, unknown>)?.qmd
                  ? (((indexStatus?.custom as Record<string, Record<string, unknown>>)?.qmd
                      ?.collections as number) ?? 0)
                  : 0,
              )}
              subtitle={
                (indexStatus?.custom as Record<string, Record<string, unknown>>)?.qmd?.lastUpdateAt
                  ? `Updated ${formatTimeAgo((indexStatus?.custom as Record<string, Record<string, unknown>>)?.qmd?.lastUpdateAt as number)}`
                  : undefined
              }
            />
            <StatCard
              icon={<HardDrive className="size-4" />}
              label="Backend"
              value="qmd"
              subtitle={indexStatus?.provider}
            />
          </>
        ) : (
          <>
            <StatCard
              icon={<FileText className="size-4" />}
              label="Files"
              value={String(indexStatus?.files ?? 0)}
              subtitle={indexStatus?.workspaceDir}
            />
            <StatCard
              icon={<Layers className="size-4" />}
              label="Chunks"
              value={String(indexStatus?.chunks ?? 0)}
              subtitle={indexStatus?.dirty ? "Index has pending changes" : undefined}
            />
            <StatCard
              icon={<HardDrive className="size-4" />}
              label="Backend"
              value={indexStatus?.backend ?? "none"}
              subtitle={indexStatus?.provider}
            />
          </>
        )}
      </div>

      {/* Collection Details (QMD) */}
      {isQmd &&
        (() => {
          const qmdCustom = (indexStatus?.custom as Record<string, Record<string, unknown>>)?.qmd;
          const details = qmdCustom?.collectionDetails as
            | Array<{ name: string; kind: string; pattern: string; path: string }>
            | undefined;
          if (!details?.length) {
            return null;
          }
          return (
            <div className="rounded-lg border p-4 space-y-2">
              <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Collections ({details.length})
              </h3>
              <div className="space-y-1.5">
                {details.map((c) => (
                  <div key={c.name} className="flex items-center gap-3 text-xs">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] font-mono shrink-0",
                        c.kind === "sessions"
                          ? "text-blue-400 border-blue-500/30"
                          : c.kind === "native"
                            ? "text-amber-400 border-amber-500/30"
                            : c.kind === "custom"
                              ? "text-purple-400 border-purple-500/30"
                              : "text-emerald-400 border-emerald-500/30",
                      )}
                    >
                      {c.kind}
                    </Badge>
                    <span className="font-mono text-foreground truncate">{c.name}</span>
                    <span
                      className="text-muted-foreground font-mono truncate ml-auto"
                      title={c.path}
                    >
                      {c.pattern}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

      {/* Health Score */}
      {healthScore && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Health Score
            </h3>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-2xl font-bold font-mono",
                  healthScore.score >= 8
                    ? "text-emerald-400"
                    : healthScore.score >= 5
                      ? "text-yellow-400"
                      : "text-red-400",
                )}
              >
                {healthScore.score}/10
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "text-xs font-mono",
                  healthScore.grade === "A"
                    ? "text-emerald-400 border-emerald-500/30"
                    : healthScore.grade === "B"
                      ? "text-emerald-400 border-emerald-500/30"
                      : healthScore.grade === "C"
                        ? "text-yellow-400 border-yellow-500/30"
                        : "text-red-400 border-red-500/30",
                )}
              >
                {healthScore.grade}
              </Badge>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {[
              { label: "Index", value: healthScore.factors.indexContent, max: 3 },
              { label: "Embed", value: healthScore.factors.embedding, max: 2 },
              { label: "Memory", value: healthScore.factors.memoryMdRecency, max: 2 },
              { label: "Notes", value: healthScore.factors.dailyNoteActivity, max: 2 },
              { label: "Primary", value: healthScore.factors.noFallback, max: 1 },
            ].map((f) => (
              <div key={f.label} className="text-center">
                <div className="text-[10px] text-muted-foreground mb-1">{f.label}</div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      f.value === f.max
                        ? "bg-emerald-500"
                        : f.value > 0
                          ? "bg-yellow-500"
                          : "bg-red-500",
                    )}
                    style={{ width: `${(f.value / f.max) * 100}%` }}
                  />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                  {f.value}/{f.max}
                </div>
              </div>
            ))}
          </div>
          {healthScore.issues.length > 0 && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              {healthScore.issues.map((issue, i) => (
                <div key={i} className="flex items-center gap-1">
                  <AlertTriangle className="size-3 text-yellow-400 shrink-0" />
                  <span>{issue}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Source counts table — primarily useful for builtin backend */}
      {!isQmd && sourceData.length > 0 && (
        <div>
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
            Sources
          </h3>
          <DataTable columns={sourceColumns} data={sourceData} keyField="source" compact />
        </div>
      )}

      {/* Additional info — backend-adaptive */}
      <div className="space-y-2">
        {indexStatus?.model && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">Model:</span>
            <Badge variant="outline" className="text-xs font-mono">
              {indexStatus.model}
            </Badge>
          </div>
        )}

        {isQmd ? (
          // QMD manages its own embeddings — always show vector as available
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">Vector:</span>
            <Badge variant="outline" className="text-xs font-mono text-emerald-400">
              managed by qmd
            </Badge>
          </div>
        ) : (
          <>
            {indexStatus?.vector && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">Vector:</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-mono",
                    indexStatus.vector.available ? "text-emerald-400" : "text-muted-foreground",
                  )}
                >
                  {indexStatus.vector.available ? "available" : "unavailable"}
                  {indexStatus.vector.dims ? ` (${indexStatus.vector.dims}d)` : ""}
                </Badge>
              </div>
            )}

            {indexStatus?.fts && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">FTS:</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-mono",
                    indexStatus.fts.available ? "text-emerald-400" : "text-muted-foreground",
                  )}
                >
                  {indexStatus.fts.available ? "available" : "unavailable"}
                </Badge>
              </div>
            )}

            {indexStatus?.cache && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">Cache:</span>
                <Badge variant="outline" className="text-xs font-mono">
                  {indexStatus.cache.enabled ? "enabled" : "disabled"}
                  {indexStatus.cache.entries != null
                    ? ` (${indexStatus.cache.entries}/${indexStatus.cache.maxEntries ?? "∞"})`
                    : ""}
                </Badge>
              </div>
            )}

            {indexStatus?.batch && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">Batch:</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-mono",
                    indexStatus.batch.failures > 0 ? "text-yellow-400" : undefined,
                  )}
                >
                  {indexStatus.batch.enabled ? "enabled" : "disabled"}
                  {indexStatus.batch.failures > 0
                    ? ` (${indexStatus.batch.failures} failures)`
                    : ""}
                </Badge>
              </div>
            )}
          </>
        )}
      </div>

      {/* Issues panel — driven by detectMemoryIssues() */}
      {issues.length > 0 && (
        <div className="space-y-2">
          {issues.map((issue, i) => (
            <div
              key={i}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 text-xs",
                issue.level === "error"
                  ? "border-red-500/30 bg-red-500/10 text-red-400"
                  : "border-yellow-500/30 bg-yellow-500/10 text-yellow-400",
              )}
            >
              {issue.level === "error" ? (
                <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
              )}
              <p>{issue.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Files Tab ---

type AgentOption = { id: string; name?: string; emoji?: string };

function FilesTab() {
  const {
    files,
    selectedFile,
    fileContent,
    originalFileContent,
    filesLoading,
    fileLoading,
    fileSaving,
    agentId,
    highlightLine,
    highlightTerm,
  } = useMemoryStore();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { listMemoryFiles, getMemoryFile, setMemoryFile, deleteMemoryFile, createMemoryFile } =
    useMemory();
  const { listAgents } = useAgents();

  // Create/delete state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Agent selector
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(agentId);

  // Sync selectedAgentId when the store's agentId is first populated (e.g. after memory.status)
  useEffect(() => {
    if (agentId && !selectedAgentId) {
      setSelectedAgentId(agentId);
    }
  }, [agentId, selectedAgentId]);

  // Load agent list once on mount
  useEffect(() => {
    listAgents()
      .then((result) => {
        const opts: AgentOption[] = (result.agents ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          emoji: a.identity?.emoji,
        }));
        setAgentOptions(opts);
      })
      .catch(() => {
        /* ignore */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAgentChange = async (newId: string) => {
    setSelectedAgentId(newId);
    useMemoryStore.getState().setAgentId(newId);
    useMemoryStore.getState().setSelectedFile(null);
    useMemoryStore.getState().setFileContent("");
    useMemoryStore.getState().setOriginalFileContent("");
    await listMemoryFiles(newId);
  };

  // Use selectedAgentId locally; fall back to store agentId
  const effectiveAgentId = selectedAgentId ?? agentId;

  // Local UI state
  const [identityCollapsed, setIdentityCollapsed] = useState(() => {
    try {
      return localStorage.getItem(IDENTITY_COLLAPSED_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [showAllMemory, setShowAllMemory] = useState(() => {
    try {
      return localStorage.getItem(MEMORY_SHOW_ALL_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [fileFilter, setFileFilter] = useState("");

  // --- All derived state (hooks must be called before any early return) ---

  const hasChanges = fileContent !== originalFileContent;

  // Classify files: memory vs identity. Include missing MEMORY.md in memory section.
  const isMemoryFileName = (name: string) =>
    name === "MEMORY.md" || name === "memory.md" || name.startsWith("memory/");

  const allMemoryFiles = files.filter((f) => isMemoryFileName(f.name));
  const identityFiles = files.filter((f) => !isMemoryFileName(f.name) && !f.missing);

  // Sort memory files: MEMORY.md/memory.md pinned at top, then dated journals newest-first
  const sortedMemoryFiles = useMemo(() => {
    const pinned = allMemoryFiles.filter((f) => f.name === "MEMORY.md" || f.name === "memory.md");
    const journals = allMemoryFiles
      .filter((f) => f.name !== "MEMORY.md" && f.name !== "memory.md" && !f.missing)
      .slice()
      .toSorted((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
    return [...pinned, ...journals];
  }, [allMemoryFiles]);

  // Apply filter
  const filterLower = fileFilter.toLowerCase();
  const filteredMemoryFiles = filterLower
    ? sortedMemoryFiles.filter(
        (f) =>
          f.name.toLowerCase().includes(filterLower) ||
          memoryDisplayName(f.name).toLowerCase().includes(filterLower),
      )
    : sortedMemoryFiles;
  const filteredIdentityFiles = filterLower
    ? identityFiles.filter((f) => f.name.toLowerCase().includes(filterLower))
    : identityFiles;

  // Truncation: show limited memory files unless expanded or filtering
  const shouldTruncate =
    !showAllMemory && !filterLower && filteredMemoryFiles.length > MEMORY_TRUNCATE_LIMIT;
  const visibleMemoryFiles = shouldTruncate
    ? filteredMemoryFiles.slice(0, MEMORY_TRUNCATE_LIMIT)
    : filteredMemoryFiles;
  const hiddenCount = shouldTruncate ? filteredMemoryFiles.length - MEMORY_TRUNCATE_LIMIT : 0;

  const hasAnyFiles = sortedMemoryFiles.length > 0 || identityFiles.length > 0;

  // --- End derived state ---

  const handleSelectFile = async (name: string, isMissing?: boolean) => {
    if (!effectiveAgentId) {
      return;
    }
    useMemoryStore.getState().setSelectedFile(name);
    if (isMissing) {
      // For missing files, start with empty editor (save will create the file)
      useMemoryStore.getState().setFileContent("");
      useMemoryStore.getState().setOriginalFileContent("");
    } else {
      await getMemoryFile(effectiveAgentId, name);
    }
  };

  const handleSave = async () => {
    if (!effectiveAgentId || !selectedFile) {
      return;
    }
    await setMemoryFile(effectiveAgentId, selectedFile, fileContent);
    // Refresh file list in case a new file was created
    await listMemoryFiles(effectiveAgentId);
  };

  const handleRevert = () => {
    useMemoryStore.getState().setFileContent(originalFileContent);
  };

  const handleRefresh = async () => {
    if (!effectiveAgentId) {
      return;
    }
    await listMemoryFiles(effectiveAgentId);
    if (selectedFile) {
      await getMemoryFile(effectiveAgentId, selectedFile);
    }
  };

  const handleDelete = async () => {
    if (!effectiveAgentId || !selectedFile) {
      return;
    }
    setDeleting(true);
    try {
      await deleteMemoryFile(effectiveAgentId, selectedFile);
      await listMemoryFiles(effectiveAgentId);
    } catch (err) {
      console.error("[memory] delete failed:", err);
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = async () => {
    if (!effectiveAgentId || !newFileName.trim()) {
      return;
    }
    const name = newFileName.trim().endsWith(".md")
      ? newFileName.trim()
      : `${newFileName.trim()}.md`;
    const fullName = name.startsWith("memory/") ? name : `memory/${name}`;
    setCreating(true);
    try {
      await createMemoryFile(
        effectiveAgentId,
        fullName,
        `# ${name.replace("memory/", "").replace(".md", "")}\n\n`,
      );
      await listMemoryFiles(effectiveAgentId);
      useMemoryStore.getState().setSelectedFile(fullName);
      await getMemoryFile(effectiveAgentId, fullName);
      setShowCreateDialog(false);
      setNewFileName("");
    } catch (err) {
      console.error("[memory] create failed:", err);
    } finally {
      setCreating(false);
    }
  };

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!effectiveAgentId) {
      return;
    }
    setExporting(true);
    try {
      const fileContents: Array<{ name: string; content: string }> = [];
      for (const f of files) {
        if (f.missing) {
          continue;
        }
        try {
          await getMemoryFile(effectiveAgentId, f.name);
          const content = useMemoryStore.getState().fileContent;
          fileContents.push({ name: f.name, content });
        } catch {
          // Skip files that fail to load
        }
      }
      // Create a combined text export (one file per section)
      const combined = fileContents.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n");
      const blob = new Blob([combined], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memory-export-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[memory] export failed:", err);
    } finally {
      setExporting(false);
      // Restore selected file
      if (selectedFile && effectiveAgentId) {
        await getMemoryFile(effectiveAgentId, selectedFile);
      }
    }
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.txt";
    input.multiple = true;
    input.addEventListener("change", async () => {
      if (!input.files || !effectiveAgentId) {
        return;
      }
      for (const file of Array.from(input.files)) {
        const content = await file.text();
        const name = file.name.startsWith("memory/") ? file.name : `memory/${file.name}`;
        try {
          await setMemoryFile(effectiveAgentId, name, content);
        } catch {
          // If file doesn't exist, try creating it
          try {
            await createMemoryFile(effectiveAgentId, name, content);
          } catch (err) {
            console.error(`[memory] import failed for ${name}:`, err);
          }
        }
      }
      await listMemoryFiles(effectiveAgentId);
    });
    input.click();
  };

  // Scroll textarea to highlighted line when file content loads
  useEffect(() => {
    if (!highlightLine || !fileContent || !editorRef.current) {
      return;
    }
    const textarea = editorRef.current;
    const lines = fileContent.split("\n");
    const lineHeight = textarea.scrollHeight / Math.max(lines.length, 1);
    const targetScroll = Math.max(0, (highlightLine - 3) * lineHeight);
    textarea.scrollTop = targetScroll;
    // Sync overlay scroll
    if (overlayRef.current) {
      overlayRef.current.scrollTop = targetScroll;
    }

    // Place cursor at the highlighted line
    const charOffset = lines.slice(0, highlightLine - 1).reduce((sum, l) => sum + l.length + 1, 0);
    const lineEnd = charOffset + (lines[highlightLine - 1]?.length ?? 0);
    textarea.setSelectionRange(charOffset, lineEnd);
    textarea.focus();

    // Clear highlight line (but keep highlightTerm for a few seconds)
    useMemoryStore.getState().setHighlightLine(null);
  }, [highlightLine, fileContent, fileLoading]);

  // Clear highlight term after 10 seconds or on edit
  useEffect(() => {
    if (!highlightTerm) {
      return;
    }
    const timer = setTimeout(() => {
      useMemoryStore.getState().setHighlightTerm(null);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [highlightTerm]);

  const toggleIdentityCollapsed = () => {
    const next = !identityCollapsed;
    setIdentityCollapsed(next);
    try {
      localStorage.setItem(IDENTITY_COLLAPSED_KEY, String(next));
    } catch {}
  };

  const toggleShowAll = () => {
    const next = !showAllMemory;
    setShowAllMemory(next);
    try {
      localStorage.setItem(MEMORY_SHOW_ALL_KEY, String(next));
    } catch {}
  };

  if (filesLoading && files.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!hasAnyFiles) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
        <FileText className="size-10 opacity-40" />
        <p className="text-sm">No memory files available</p>
        <p className="text-xs">Memory files are created by the agent during conversations</p>
      </div>
    );
  }

  const renderFileButton = (f: (typeof files)[number]) => {
    const isMissing = f.missing;
    const displayName = isMemoryFileName(f.name) ? memoryDisplayName(f.name) : f.name;

    return (
      <button
        key={f.name}
        onClick={() => handleSelectFile(f.name, isMissing)}
        title={f.name}
        className={cn(
          "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
          "hover:bg-secondary/60",
          selectedFile === f.name
            ? "bg-primary/10 text-primary border border-primary/20"
            : isMissing
              ? "text-muted-foreground"
              : "text-foreground",
        )}
      >
        <div className="flex items-center gap-2">
          <FileText className={cn("size-3.5 shrink-0", isMissing ? "opacity-30" : "opacity-60")} />
          <span className={cn("font-mono text-xs truncate", isMissing && "italic")}>
            {displayName}
          </span>
          {isMissing && <Plus className="size-3 shrink-0 text-muted-foreground/50" />}
        </div>
        {!isMissing && (
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
            <span>{formatFileSize(f.size)}</span>
            <span>{formatTimeAgo(f.updatedAtMs)}</span>
          </div>
        )}
        {isMissing && (
          <div className="text-[10px] text-muted-foreground/50 mt-1">Click to create</div>
        )}
      </button>
    );
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-220px)] min-h-[400px]">
      {/* File list */}
      <div className="w-56 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Files
          </span>
          <Button variant="ghost" size="xs" onClick={handleRefresh} disabled={filesLoading}>
            <RefreshCw className={cn("size-3", filesLoading && "animate-spin")} />
          </Button>
        </div>

        {/* Agent selector */}
        {agentOptions.length > 1 && (
          <div className="mb-2">
            <select
              value={effectiveAgentId ?? ""}
              onChange={(e) => void handleAgentChange(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.emoji ? `${a.emoji} ` : ""}
                  {a.name ?? a.id}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Create file dialog */}
        {showCreateDialog && (
          <div className="flex gap-1.5 mb-2">
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="filename.md"
              autoFocus
              className="flex-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={creating || !newFileName.trim()}
              className="h-7 text-xs gap-1"
            >
              {creating ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              Create
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowCreateDialog(false);
                setNewFileName("");
              }}
              className="h-7 text-xs"
            >
              <X className="size-3" />
            </Button>
          </div>
        )}

        {/* New file + filter input */}
        <div className="flex gap-1.5 mb-2">
          <div className="relative flex-1">
            <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <input
              type="text"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Filter files..."
              className="w-full rounded-md border border-border bg-card pl-7 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            {fileFilter && (
              <button
                onClick={() => setFileFilter("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateDialog(!showCreateDialog)}
            className="h-7 px-2"
            title="Create new memory file"
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting || files.length === 0}
            className="h-7 px-2"
            title="Export all memory files"
          >
            {exporting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleImport}
            className="h-7 px-2"
            title="Import memory files"
          >
            <Upload className="size-3.5" />
          </Button>
        </div>

        <ScrollArea className="flex-1 rounded-lg border border-border bg-card">
          <div className="p-1">
            {/* Memory section */}
            {visibleMemoryFiles.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  Memory
                </div>
                {visibleMemoryFiles.map(renderFileButton)}
                {hiddenCount > 0 && (
                  <button
                    onClick={toggleShowAll}
                    className="w-full text-center py-1.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
                  >
                    Show all ({filteredMemoryFiles.length})
                  </button>
                )}
                {showAllMemory && filteredMemoryFiles.length > MEMORY_TRUNCATE_LIMIT && (
                  <button
                    onClick={toggleShowAll}
                    className="w-full text-center py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Show less
                  </button>
                )}
              </div>
            )}

            {/* Agent Identity section — collapsible */}
            {filteredIdentityFiles.length > 0 && (
              <div className={visibleMemoryFiles.length > 0 ? "mt-2" : undefined}>
                <button
                  onClick={toggleIdentityCollapsed}
                  className="flex items-center gap-1 px-3 py-1.5 w-full text-left text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                >
                  {identityCollapsed ? (
                    <ChevronRight className="size-3" />
                  ) : (
                    <ChevronDown className="size-3" />
                  )}
                  Agent Identity
                  <span className="ml-auto text-muted-foreground/50">
                    {filteredIdentityFiles.length}
                  </span>
                </button>
                {!identityCollapsed && filteredIdentityFiles.map(renderFileButton)}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-sm text-primary">{selectedFile}</span>
              {hasChanges && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-yellow-400 border-yellow-500/30"
                >
                  unsaved
                </Badge>
              )}
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting || fileSaving}
                  className="gap-1.5 text-red-400 hover:text-red-300 hover:border-red-500/30"
                  title="Delete file"
                >
                  {deleting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRevert}
                  disabled={!hasChanges || fileSaving}
                  className="gap-1.5"
                >
                  <Undo2 className="size-3.5" />
                  Revert
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!hasChanges || fileSaving}
                  className="gap-1.5"
                >
                  {fileSaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
            {fileLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="relative flex-1">
                {/* Highlight overlay — mirrors textarea content with <mark> tags */}
                {highlightTerm && (
                  <div
                    ref={overlayRef}
                    aria-hidden
                    className="absolute inset-0 rounded-lg p-3 font-mono text-sm whitespace-pre-wrap break-words overflow-hidden pointer-events-none text-transparent"
                    style={{ wordBreak: "break-all" }}
                  >
                    <HighlightText
                      text={fileContent}
                      term={highlightTerm}
                      className="bg-yellow-400/30 text-transparent rounded-sm"
                    />
                  </div>
                )}
                <textarea
                  ref={editorRef}
                  value={fileContent}
                  onChange={(e) => {
                    useMemoryStore.getState().setFileContent(e.target.value);
                    // Clear highlight on edit
                    if (highlightTerm) {
                      useMemoryStore.getState().setHighlightTerm(null);
                    }
                  }}
                  onScroll={() => {
                    // Sync overlay scroll with textarea
                    if (overlayRef.current && editorRef.current) {
                      overlayRef.current.scrollTop = editorRef.current.scrollTop;
                    }
                  }}
                  className={cn(
                    "flex-1 w-full h-full rounded-lg border border-border p-3 font-mono text-sm text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary/50",
                    highlightTerm ? "bg-transparent" : "bg-card",
                  )}
                  spellCheck={false}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  );
}

// --- Search Tab ---

function SearchTab() {
  const {
    searchQuery,
    searchResults,
    searching,
    searchBackend,
    searchFiles,
    searchFallback,
    searchHistory,
    indexStatus,
    expandedResultId,
    searchSourceFilter,
    searchSortBy,
  } = useMemoryStore();
  const { searchMemory, getMemoryFile } = useMemory();
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim()) {
      return;
    }
    setShowHistory(false);
    await searchMemory(searchQuery.trim());
  };

  const handleHistorySelect = (query: string) => {
    useMemoryStore.getState().setSearchQuery(query);
    setShowHistory(false);
    // Search immediately
    void searchMemory(query);
  };

  const handleResultClick = (result: MemorySearchResultUI, index: number) => {
    const store = useMemoryStore.getState();
    const agentId = store.agentId;

    const isSessionResult = result.source === "sessions" || result.path.startsWith("qmd/sessions-");
    const isNativeQmdResult = !isSessionResult && result.path.startsWith("qmd/");

    // Session and native QMD results can't be opened in the Files tab — expand inline
    if (isSessionResult || isNativeQmdResult) {
      const currentExpanded = store.expandedResultId;
      store.setExpandedResultId(currentExpanded === index ? null : index);
      return;
    }

    // Memory file results: navigate to Files tab with keyword highlighting
    const fileName = result.path;
    store.setActiveTab("files");
    store.setSelectedFile(fileName);
    store.setHighlightLine(result.startLine);
    store.setHighlightTerm(store.searchQuery);
    if (agentId) {
      getMemoryFile(agentId, fileName).catch(() => {
        // File not found in workspace — show error instead of blank pane
        store.setFileContent(
          "# File not available\n\nThis file could not be loaded from the agent workspace.",
        );
        store.setOriginalFileContent("");
      });
    }
  };

  // Apply client-side source filter and sort
  const filteredResults = useMemo(() => {
    let results = searchResults;
    if (searchSourceFilter !== "all") {
      results = results.filter((r) => {
        const isSession = r.source === "sessions" || r.path.startsWith("qmd/sessions-");
        const isProject = !isSession && r.path.startsWith("qmd/projects-");
        const isDocs = !isSession && !isProject && r.path.startsWith("qmd/");
        if (searchSourceFilter === "sessions") {
          return isSession;
        }
        if (searchSourceFilter === "projects") {
          return isProject;
        }
        if (searchSourceFilter === "docs") {
          return isDocs;
        }
        // "memory" = workspace memory files (not sessions, not docs, not projects)
        return !isSession && !isDocs && !isProject;
      });
    }
    if (searchSortBy === "date") {
      results = [...results].toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    }
    return results;
  }, [searchResults, searchSourceFilter, searchSortBy]);

  return (
    <div className="space-y-4">
      {/* Search input */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => useMemoryStore.getState().setSearchQuery(e.target.value)}
            onFocus={() => searchHistory.length > 0 && setShowHistory(true)}
            onBlur={() => setTimeout(() => setShowHistory(false), 200)}
            placeholder="Search memory..."
            className="w-full rounded-lg border border-border bg-card pl-10 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {/* Search history dropdown */}
          {showHistory && searchHistory.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 z-10 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
              <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground border-b border-border">
                Recent searches
              </div>
              {searchHistory.map((q, i) => (
                <button
                  key={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleHistorySelect(q);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-secondary/60 transition-colors flex items-center gap-2"
                >
                  <Clock className="size-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{q}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button type="submit" disabled={searching || !searchQuery.trim()} className="gap-1.5">
          {searching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Search className="size-3.5" />
          )}
          Search
        </Button>
      </form>

      {/* Search filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Source:
          </span>
          {(["all", "memory", "docs", "sessions", "projects"] as const).map((f) => (
            <button
              key={f}
              onClick={() => useMemoryStore.getState().setSearchSourceFilter(f)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-mono transition-colors",
                searchSourceFilter === f
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Sort:</span>
          {(["relevance", "date"] as const).map((s) => (
            <button
              key={s}
              onClick={() => useMemoryStore.getState().setSearchSortBy(s)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-mono transition-colors",
                searchSortBy === s
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Backend + search mode info */}
      {searchBackend && (
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] font-mono">
            backend: {searchBackend}
          </Badge>
          {searchBackend === "builtin" && indexStatus?.custom && (
            <Badge variant="outline" className="text-[10px] font-mono">
              mode: {(indexStatus.custom.searchMode as string) ?? "unknown"}
            </Badge>
          )}
        </div>
      )}

      {/* Text search fallback indicator */}
      {searchFallback && filteredResults.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 p-2.5 text-xs text-blue-400">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>Text search — semantic search returned empty, showing text matches</span>
        </div>
      )}

      {/* Results */}
      {searching ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : filteredResults.length > 0 ? (
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">
            {filteredResults.length} result{filteredResults.length !== 1 ? "s" : ""}
            {searchSourceFilter !== "all" && ` (${searchSourceFilter})`}
          </span>
          {filteredResults.map((result, i) => {
            const isSession =
              result.source === "sessions" || result.path.startsWith("qmd/sessions-");
            const isProject = !isSession && result.path.startsWith("qmd/projects-");
            const isDocs = !isSession && !isProject && result.path.startsWith("qmd/");
            const isExpandable = isSession || isDocs || isProject;
            const isExpanded = expandedResultId === i;
            const sourceLabel = isSession
              ? "session"
              : isProject
                ? "project"
                : isDocs
                  ? "docs"
                  : result.source;
            return (
              <button
                key={i}
                onClick={() => handleResultClick(result, i)}
                className={cn(
                  "w-full text-left rounded-lg border bg-card p-3 transition-colors",
                  isExpanded ? "border-primary/30" : "border-border hover:border-primary/20",
                )}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  {isSession ? (
                    <Activity className="size-3.5 text-muted-foreground shrink-0" />
                  ) : isDocs ? (
                    <Database className="size-3.5 text-amber-400 shrink-0" />
                  ) : (
                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-mono text-xs text-primary truncate">
                    {result.path}:{result.startLine}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] font-mono ml-auto shrink-0",
                      scoreBadgeColor(result.score),
                    )}
                  >
                    {result.score.toFixed(2)}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] font-mono shrink-0",
                      isDocs
                        ? "text-amber-400 border-amber-500/30"
                        : isSession
                          ? "text-blue-400 border-blue-500/30"
                          : "",
                    )}
                  >
                    {sourceLabel}
                  </Badge>
                  {result.modifiedAt && (
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                      {new Date(result.modifiedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  )}
                </div>
                {result.snippet && (
                  <div
                    className={cn(
                      "text-xs text-muted-foreground font-mono leading-relaxed whitespace-pre-wrap",
                      isExpanded
                        ? "mt-2 p-2 rounded-md bg-secondary/40 border border-border/50"
                        : "line-clamp-3",
                    )}
                  >
                    <HighlightText text={result.snippet} term={searchQuery} />
                  </div>
                )}
                <div className="flex items-center gap-1 mt-1.5 text-[10px] text-primary/60">
                  {isExpandable ? (
                    <>
                      {isExpanded ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                      <span>{isExpanded ? "Collapse" : "Expand Context"}</span>
                    </>
                  ) : (
                    <>
                      <span>View in Files</span>
                      <ChevronRight className="size-3" />
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ) : searchQuery && !searching ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Search className="size-8 opacity-40" />
          {searchFiles != null && searchFiles === 0 ? (
            <>
              <p className="text-sm">No documents indexed yet</p>
              <p className="text-xs">
                {searchBackend === "qmd"
                  ? "Try re-indexing from the Index Status tab."
                  : "The index may be empty. Check Index Status for details."}
              </p>
            </>
          ) : searchBackend === "qmd" && searchQuery.trim().length < 4 ? (
            <>
              <p className="text-sm">Query too short for semantic search</p>
              <p className="text-xs text-center max-w-xs">
                QMD uses vector embeddings — short abbreviations like &quot;{searchQuery.trim()}
                &quot; won&apos;t match. Try a descriptive phrase, e.g. &quot;project
                management&quot; or &quot;authentication flow&quot;.
              </p>
            </>
          ) : searchBackend === "qmd" ? (
            <>
              <p className="text-sm">No semantic matches found</p>
              <p className="text-xs text-center max-w-xs">
                QMD ranks by meaning, not keywords. Try rephrasing with more context, or use a full
                sentence describing what you&apos;re looking for.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm">No results matched your query</p>
              <p className="text-xs">Try different search terms or broaden your query.</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// --- Activity Log Tab ---

function ActivityLogTab() {
  const { activityLog, activityLoading, activityFilter } = useMemoryStore();
  const { loadActivityLog } = useMemory();
  const loadedRef = useRef(false);
  const [displayLimit, setDisplayLimit] = useState(20);

  // Load all activity once on mount
  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      void loadActivityLog();
    }
  }, [loadActivityLog]);

  const filteredLog = activityLog.filter((entry) => {
    if (activityFilter === "all") {
      return true;
    }
    if (activityFilter === "reads") {
      return entry.operation === "read" || entry.operation === "search";
    }
    if (activityFilter === "writes") {
      return entry.operation === "write" || entry.operation === "edit";
    }
    return true;
  });

  const visibleLog = filteredLog.slice(0, displayLimit);
  const hasMore = displayLimit < filteredLog.length;

  const handleLoadMore = () => {
    setDisplayLimit((prev) => prev + 20);
  };

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div className="flex items-center gap-2">
        {(["all", "reads", "writes"] as ActivityFilter[]).map((filter) => (
          <Button
            key={filter}
            variant={activityFilter === filter ? "default" : "outline"}
            size="sm"
            onClick={() => useMemoryStore.getState().setActivityFilter(filter)}
            className="text-xs capitalize"
          >
            {filter}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void loadActivityLog();
          }}
          disabled={activityLoading}
          className="ml-auto"
        >
          <RefreshCw className={cn("size-3.5", activityLoading && "animate-spin")} />
        </Button>
      </div>

      {/* Log entries */}
      {activityLoading && visibleLog.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : visibleLog.length > 0 ? (
        <div className="space-y-1">
          {visibleLog.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-3 rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-xs"
            >
              <span className="text-muted-foreground font-mono shrink-0 mt-0.5">
                {formatTimestamp(entry.timestamp)}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-mono shrink-0",
                  operationBadgeColor(entry.operation),
                )}
              >
                {entry.operation}
              </Badge>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground">{entry.toolName}</span>
                  {entry.filePath && (
                    <span className="font-mono text-primary truncate">{entry.filePath}</span>
                  )}
                  {entry.query && (
                    <span className="text-foreground/80 truncate">&quot;{entry.query}&quot;</span>
                  )}
                </div>
                {entry.snippet && (
                  <p className="text-muted-foreground mt-0.5 truncate">{entry.snippet}</p>
                )}
              </div>
              <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                {entry.sessionKey}
              </Badge>
            </div>
          ))}

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="sm" onClick={handleLoadMore} className="text-xs">
                Show more ({filteredLog.length - displayLimit} remaining)
              </Button>
            </div>
          )}
          {!hasMore && filteredLog.length > 0 && (
            <p className="text-center text-[10px] text-muted-foreground pt-2">
              {filteredLog.length} total entries
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Activity className="size-8 opacity-40" />
          <p className="text-sm">No memory activity found</p>
          <p className="text-xs">Activity appears when the agent uses memory tools</p>
        </div>
      )}
    </div>
  );
}

// --- Health Alert Banner ---

function MemoryHealthAlert() {
  const { healthScore, activeTab } = useMemoryStore();
  const { reindexMemory } = useMemory();

  // Only show when health score is below threshold (4/10)
  if (!healthScore || healthScore.score >= 4) {
    return null;
  }

  // Don't show on Index tab since it already has detailed health info
  if (activeTab === "index") {
    return null;
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
      <AlertTriangle className="size-4 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1.5">
        <div className="font-medium">Memory health is degraded ({healthScore.score}/10)</div>
        <div className="space-y-0.5 text-red-400/80">
          {healthScore.issues.map((issue, i) => (
            <div key={i}>• {issue}</div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          {healthScore.factors.indexContent === 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void reindexMemory()}
              className="h-6 text-[10px] border-red-500/30 text-red-400 hover:bg-red-500/10"
            >
              <RefreshCw className="size-3 mr-1" />
              Reindex
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => useMemoryStore.getState().setActiveTab("index")}
            className="h-6 text-[10px] border-red-500/30 text-red-400 hover:bg-red-500/10"
          >
            View Details
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Main Page ---

export function MemoryPage() {
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const { activeTab } = useMemoryStore();
  const { getMemoryStatus, listMemoryFiles } = useMemory();
  const initialLoadRef = useRef(false);

  // Load data on mount + connect
  useEffect(() => {
    if (!isConnected) {
      initialLoadRef.current = false;
      return;
    }
    if (initialLoadRef.current) {
      return;
    }
    initialLoadRef.current = true;

    void getMemoryStatus().then((result) => {
      if (result?.agentId) {
        void listMemoryFiles(result.agentId);
      }
    });
  }, [isConnected, getMemoryStatus, listMemoryFiles]);

  const handleTabChange = (tab: string) => {
    useMemoryStore.getState().setActiveTab(tab);
  };

  const handleRefresh = async () => {
    const result = await getMemoryStatus();
    if (result?.agentId) {
      await listMemoryFiles(result.agentId);
    }
  };

  if (!isConnected) {
    return <DisconnectedMessage />;
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="flex items-center gap-2">
          <TabsList>
            <TabsTrigger value="index" className="gap-1.5">
              <Database className="size-3.5" />
              Index Status
            </TabsTrigger>
            <TabsTrigger value="files" className="gap-1.5">
              <FileText className="size-3.5" />
              Files
            </TabsTrigger>
            <TabsTrigger value="search" className="gap-1.5">
              <Search className="size-3.5" />
              Search
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-1.5">
              <Activity className="size-3.5" />
              Activity
            </TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="sm" onClick={handleRefresh} className="ml-auto">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>

        <MemoryHealthAlert />

        <TabsContent value="index">
          <IndexStatusTab />
        </TabsContent>
        <TabsContent value="files">
          <FilesTabErrorBoundary>
            <FilesTab />
          </FilesTabErrorBoundary>
        </TabsContent>
        <TabsContent value="search">
          <SearchTab />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityLogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
