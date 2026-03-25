import {
  Search,
  RefreshCw,
  Loader2,
  X,
  MessageSquare,
  Mic,
  Image,
  FileText,
  Globe,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useGateway } from "@/hooks/use-gateway";
import { useGatewayStore } from "@/store/gateway-store";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type PluginKind = "provider" | "channel" | "memory" | "tool" | string;
type KindFilter = "All" | "Providers" | "Channels" | "Memory" | "Tools";
type StatusFilter = "All" | "Enabled" | "Disabled";

interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  kind: PluginKind;
  enabled: boolean;
  status?: "loaded" | "error" | "disabled" | string;
  capabilities?: string[];
  version?: string;
  source?: string;
  config?: Record<string, unknown>;
}

// Shape returned by config.get (see feedback_config_get_response_shape.md)
interface ConfigSnapshot {
  config?: {
    plugins?: {
      entries?: Record<string, { enabled?: boolean; [k: string]: unknown }>;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KIND_COLORS: Record<string, string> = {
  provider: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  channel: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  memory: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  tool: "bg-green-500/10 text-green-600 border-green-500/20",
};

function kindLabel(kind: PluginKind): string {
  if (kind === "provider") return "Provider";
  if (kind === "channel") return "Channel";
  if (kind === "memory") return "Memory";
  if (kind === "tool") return "Tool";
  return kind;
}

function kindColor(kind: PluginKind): string {
  return KIND_COLORS[kind] ?? "bg-muted text-muted-foreground border-border";
}

const STATUS_COLORS: Record<string, string> = {
  loaded: "bg-green-500",
  error: "bg-red-500",
  disabled: "bg-yellow-500",
};

function CapabilityIcons({ capabilities }: { capabilities?: string[] }) {
  if (!capabilities || capabilities.length === 0) return null;
  const caps = capabilities;
  return (
    <div className="flex items-center gap-1">
      {caps.includes("text") && (
        <FileText className="size-3 text-muted-foreground" title="Text" />
      )}
      {caps.includes("speech") && (
        <Mic className="size-3 text-muted-foreground" title="Speech" />
      )}
      {caps.includes("image") && (
        <Image className="size-3 text-muted-foreground" title="Image" />
      )}
      {caps.includes("media") && (
        <MessageSquare className="size-3 text-muted-foreground" title="Media" />
      )}
      {caps.includes("search") && (
        <Globe className="size-3 text-muted-foreground" title="Search" />
      )}
    </div>
  );
}

// ── Plugin Detail Panel ───────────────────────────────────────────────────────

function PluginDetailPanel({
  plugin,
  onClose,
  onToggle,
  toggling,
}: {
  plugin: PluginInfo;
  onClose: () => void;
  onToggle: (plugin: PluginInfo) => void;
  toggling: boolean;
}) {
  return (
    <div className="border border-border rounded-lg bg-card p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm">{plugin.name}</h3>
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0", kindColor(plugin.kind))}
            >
              {kindLabel(plugin.kind)}
            </Badge>
            {plugin.status && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    STATUS_COLORS[plugin.status] ?? "bg-muted-foreground",
                  )}
                />
                {plugin.status}
              </span>
            )}
          </div>
          <span className="text-xs font-mono text-muted-foreground">{plugin.id}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={plugin.enabled}
            onCheckedChange={() => onToggle(plugin)}
            disabled={toggling}
            aria-label={plugin.enabled ? "Disable plugin" : "Enable plugin"}
          />
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {plugin.description && (
        <p className="text-sm text-muted-foreground leading-relaxed">{plugin.description}</p>
      )}

      <div className="grid grid-cols-2 gap-3 text-xs">
        {plugin.version && (
          <div>
            <span className="text-muted-foreground font-medium">Version: </span>
            <span className="font-mono">{plugin.version}</span>
          </div>
        )}
        {plugin.source && (
          <div>
            <span className="text-muted-foreground font-medium">Source: </span>
            <span className="font-mono">{plugin.source}</span>
          </div>
        )}
        {plugin.capabilities && plugin.capabilities.length > 0 && (
          <div className="col-span-2">
            <span className="text-muted-foreground font-medium">Capabilities: </span>
            <span>{plugin.capabilities.join(", ")}</span>
          </div>
        )}
      </div>

      {plugin.config && Object.keys(plugin.config).length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Configuration</h4>
          <pre className="text-[11px] font-mono bg-muted/40 border border-border rounded p-3 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
            {JSON.stringify(plugin.config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Plugin Card ───────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  onSelect,
  onToggle,
  toggling,
  selected,
}: {
  plugin: PluginInfo;
  onSelect: (plugin: PluginInfo) => void;
  onToggle: (plugin: PluginInfo) => void;
  toggling: boolean;
  selected: boolean;
}) {
  return (
    <div
      className={cn(
        "border border-border rounded-lg bg-card p-3 flex flex-col gap-2 hover:border-muted-foreground/30 transition-colors cursor-pointer",
        selected && "border-primary/50 bg-primary/5",
      )}
      onClick={() => onSelect(plugin)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium truncate">{plugin.name}</span>
          <span className="text-[11px] font-mono text-muted-foreground truncate">{plugin.id}</span>
        </div>
        {/* Stop propagation so clicking the switch doesn't also open the detail panel */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="shrink-0"
        >
          <Switch
            checked={plugin.enabled}
            onCheckedChange={() => onToggle(plugin)}
            disabled={toggling}
            aria-label={plugin.enabled ? "Disable plugin" : "Enable plugin"}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge
          variant="outline"
          className={cn("text-[10px] px-1.5 py-0", kindColor(plugin.kind))}
        >
          {kindLabel(plugin.kind)}
        </Badge>
        {plugin.status && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                STATUS_COLORS[plugin.status] ?? "bg-muted-foreground",
              )}
            />
            {plugin.status}
          </span>
        )}
        <CapabilityIcons capabilities={plugin.capabilities} />
      </div>

      {plugin.description && (
        <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
          {plugin.description}
        </p>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

const KIND_FILTER_MAP: Record<KindFilter, PluginKind | null> = {
  All: null,
  Providers: "provider",
  Channels: "channel",
  Memory: "memory",
  Tools: "tool",
};

const KIND_FILTERS: KindFilter[] = ["All", "Providers", "Channels", "Memory", "Tools"];
const STATUS_FILTERS: StatusFilter[] = ["All", "Enabled", "Disabled"];

export function PluginsPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [selectedPlugin, setSelectedPlugin] = useState<PluginInfo | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Try dedicated RPC first; fall back to config.get
      try {
        const res = await sendRpc<{ plugins: PluginInfo[] }>("plugins.list");
        if (res.plugins) {
          setPlugins(res.plugins);
          return;
        }
      } catch {
        // RPC not available yet; use config fallback below
      }

      // Fallback: derive plugin list from config
      const snap = await sendRpc<ConfigSnapshot>("config.get");
      const entries = snap?.config?.plugins?.entries ?? {};
      const derived: PluginInfo[] = Object.entries(entries).map(([id, entry]) => ({
        id,
        name: id
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        kind: "provider", // unknown without RPC; best-effort default
        enabled: entry.enabled !== false,
        status: entry.enabled !== false ? "loaded" : "disabled",
        config: entry as Record<string, unknown>,
      }));
      setPlugins(derived);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    if (isConnected) {
      void loadData();
    }
  }, [isConnected, loadData]);

  const handleToggle = useCallback(
    async (plugin: PluginInfo) => {
      setToggling(plugin.id);
      setError(null);
      try {
        const nowEnabled = !plugin.enabled;

        // Try dedicated RPCs first
        try {
          if (nowEnabled) {
            await sendRpc("plugins.enable", { id: plugin.id });
          } else {
            await sendRpc("plugins.disable", { id: plugin.id });
          }
        } catch {
          // Fall back to config.set
          await sendRpc("config.set", {
            key: `plugins.entries.${plugin.id}.enabled`,
            value: nowEnabled,
          });
        }

        // Optimistic local update
        setPlugins((prev) =>
          prev.map((p) =>
            p.id === plugin.id
              ? { ...p, enabled: nowEnabled, status: nowEnabled ? "loaded" : "disabled" }
              : p,
          ),
        );
        if (selectedPlugin?.id === plugin.id) {
          setSelectedPlugin((prev) =>
            prev ? { ...prev, enabled: nowEnabled, status: nowEnabled ? "loaded" : "disabled" } : prev,
          );
        }
      } catch (err) {
        setError(`Toggle failed for ${plugin.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setToggling(null);
      }
    },
    [sendRpc, selectedPlugin],
  );

  const filtered = useMemo(() => {
    let list = plugins;

    const kindTarget = KIND_FILTER_MAP[kindFilter];
    if (kindTarget) {
      list = list.filter((p) => p.kind === kindTarget);
    }

    if (statusFilter === "Enabled") {
      list = list.filter((p) => p.enabled);
    } else if (statusFilter === "Disabled") {
      list = list.filter((p) => !p.enabled);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q),
      );
    }

    return list;
  }, [plugins, kindFilter, statusFilter, search]);

  const enabledCount = useMemo(() => plugins.filter((p) => p.enabled).length, [plugins]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Plugins</h1>
          <p className="text-sm text-muted-foreground">
            Manage bundled and installed extensions
            {plugins.length > 0 && (
              <span className="ml-1">
                — {enabledCount} of {plugins.length} enabled
              </span>
            )}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={loadData} disabled={loading}>
          <RefreshCw className={cn("size-4 mr-1", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        {/* Kind filter */}
        <div className="flex gap-1 flex-wrap">
          {KIND_FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={kindFilter === f ? "default" : "outline"}
              onClick={() => setKindFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={statusFilter === f ? "default" : "outline"}
              onClick={() => setStatusFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="text-xs rounded p-2 font-mono border text-red-500 bg-red-500/5 border-red-500/10">
          {error}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <p className="text-sm">No plugins found.</p>
          {(search || kindFilter !== "All" || statusFilter !== "All") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearch("");
                setKindFilter("All");
                setStatusFilter("All");
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onSelect={(p) =>
                setSelectedPlugin((prev) => (prev?.id === p.id ? null : p))
              }
              onToggle={handleToggle}
              toggling={toggling === plugin.id}
              selected={selectedPlugin?.id === plugin.id}
            />
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selectedPlugin && (
        <PluginDetailPanel
          plugin={selectedPlugin}
          onClose={() => setSelectedPlugin(null)}
          onToggle={handleToggle}
          toggling={toggling === selectedPlugin.id}
        />
      )}
    </div>
  );
}
