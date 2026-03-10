import {
  Database,
  Plus,
  RefreshCw,
  Loader2,
  Globe,
  Lock,
  Trash2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────────────

interface Registry {
  id: string;
  name: string;
  url: string;
  description?: string;
  visibility: "public" | "private";
  enabled: boolean;
  agentCount?: number;
  lastSynced?: string;
  bundled?: boolean;
}

// ── Add registry modal ───────────────────────────────────────────────────────

function AddRegistryModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (reg: {
    id: string;
    name: string;
    url: string;
    visibility: "public" | "private";
    authTokenEnv?: string;
  }) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [authTokenEnv, setAuthTokenEnv] = useState("");

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Add Registry</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            &times;
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Registry ID *</label>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="company" />
          </div>
          <div>
            <label className="text-sm font-medium">Display Name *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company Internal"
            />
          </div>
          <div>
            <label className="text-sm font-medium">URL *</label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/company/agents"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Visibility</label>
            <div className="flex gap-3 mt-1">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  checked={visibility === "public"}
                  onChange={() => setVisibility("public")}
                />
                Public
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  checked={visibility === "private"}
                  onChange={() => setVisibility("private")}
                />
                Private
              </label>
            </div>
          </div>
          {visibility === "private" && (
            <div>
              <label className="text-sm font-medium">Auth Token (env var name)</label>
              <Input
                value={authTokenEnv}
                onChange={(e) => setAuthTokenEnv(e.target.value)}
                placeholder="COMPANY_AGENTS_TOKEN"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!id || !name || !url}
            onClick={() => {
              onAdd({ id, name, url, visibility, authTokenEnv: authTokenEnv || undefined });
              onClose();
            }}
          >
            Add &amp; Sync
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Registry card ────────────────────────────────────────────────────────────

interface SyncedAgentSummary {
  id: string;
  name: string;
  version: string;
  tier: number;
}

function RegistryCard({
  registry,
  onSync,
  onRemove,
  syncing,
  expanded,
  onToggleExpand,
  syncedAgents,
}: {
  registry: Registry;
  onSync: (id: string) => void;
  onRemove: (id: string) => void;
  syncing: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
  syncedAgents: SyncedAgentSummary[];
}) {
  const isSyncing = syncing === registry.id;

  return (
    <div
      className={cn(
        "rounded-lg border p-4 space-y-2 transition-colors",
        !registry.enabled && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between cursor-pointer" onClick={onToggleExpand}>
        <div className="flex items-center gap-2">
          {registry.visibility === "private" ? (
            <Lock className="size-4 text-amber-500" />
          ) : (
            <Globe className="size-4 text-blue-500" />
          )}
          <div>
            <h3 className="font-semibold">{registry.name}</h3>
            {registry.url ? (
              <p className="text-xs text-muted-foreground">{registry.url}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Built-in</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs px-2 py-0.5 rounded-full border",
              registry.visibility === "private"
                ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                : "bg-blue-500/10 text-blue-600 border-blue-500/20",
            )}
          >
            {registry.visibility}
          </span>
          {expanded ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {registry.description && (
        <p className="text-sm text-muted-foreground">{registry.description}</p>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {registry.agentCount !== undefined && <span>{registry.agentCount} agents</span>}
        {registry.bundled ? (
          <span>Bundled with Operator1</span>
        ) : registry.lastSynced ? (
          <span>Last synced: {registry.lastSynced}</span>
        ) : (
          <span>Not synced</span>
        )}
      </div>

      {!registry.bundled && (
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onSync(registry.id);
            }}
            disabled={isSyncing || !registry.enabled}
          >
            {isSyncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            <span className="ml-1">Sync</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(registry.id);
            }}
          >
            <Trash2 className="size-3.5" />
            <span className="ml-1">Remove</span>
          </Button>
        </div>
      )}

      {expanded && syncedAgents.length > 0 && (
        <div className="border-t pt-3 mt-2 space-y-1">
          <p className="text-xs font-medium text-muted-foreground mb-2">Agents in this registry</p>
          {syncedAgents.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between text-sm py-1 px-2 rounded hover:bg-muted/50"
            >
              <div>
                <span className="font-medium">{a.name}</span>
                <span className="text-muted-foreground ml-2 text-xs">T{a.tier}</span>
              </div>
              <span className="text-xs text-muted-foreground">v{a.version}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && syncedAgents.length === 0 && !registry.bundled && (
        <div className="border-t pt-3 mt-2">
          <p className="text-xs text-muted-foreground">
            No agents synced yet. Click Sync to fetch agents from this registry.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentRegistriesPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [registries, setRegistries] = useState<Registry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [syncedAgents, setSyncedAgents] = useState<Record<string, SyncedAgentSummary[]>>({});

  const fetchRegistries = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    setLoading(true);
    try {
      const res = await sendRpc("agents.marketplace.registries", {});
      if (res && Array.isArray(res.registries)) {
        setRegistries(res.registries as Registry[]);
      }
    } catch {
      setRegistries([]);
    } finally {
      setLoading(false);
    }
  }, [isConnected, sendRpc]);

  useEffect(() => {
    void fetchRegistries();
  }, [fetchRegistries]);

  const handleSync = useCallback(
    async (registryId: string) => {
      setSyncing(registryId);
      try {
        const res = await sendRpc("agents.marketplace.sync", { registryId });
        if (res && Array.isArray(res.agents)) {
          setSyncedAgents((prev) => ({
            ...prev,
            [registryId]: res.agents as SyncedAgentSummary[],
          }));
        }
        await fetchRegistries();
        setExpandedId(registryId);
      } catch {
        // Sync RPC not available yet
      } finally {
        setSyncing(null);
      }
    },
    [sendRpc, fetchRegistries],
  );

  const handleAdd = useCallback(
    async (reg: {
      id: string;
      name: string;
      url: string;
      visibility: "public" | "private";
      authTokenEnv?: string;
    }) => {
      try {
        await sendRpc("agents.marketplace.registry.add", reg);
        await fetchRegistries();
      } catch {
        // RPC not available yet
      }
    },
    [sendRpc, fetchRegistries],
  );

  const handleRemove = useCallback(
    async (registryId: string) => {
      try {
        await sendRpc("agents.marketplace.registry.remove", { id: registryId });
        await fetchRegistries();
      } catch {
        // RPC not available yet
      }
    },
    [sendRpc, fetchRegistries],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Registries</h2>
          <p className="text-muted-foreground">Manage agent registries and sources</p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="size-4 mr-1" />
          Add Registry
        </Button>
      </div>

      {registries.length === 0 && !loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-12">
          <div className="text-center space-y-2">
            <Database className="mx-auto size-10 text-muted-foreground" />
            <h3 className="font-semibold">No registries configured</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Add a registry to browse and install agents from external sources, or add via CLI:
              <code className="block mt-2 text-xs bg-muted px-2 py-1 rounded">
                openclaw agents registry add company https://github.com/company/agents
              </code>
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {registries.map((reg) => (
            <RegistryCard
              key={reg.id}
              registry={reg}
              onSync={handleSync}
              onRemove={handleRemove}
              syncing={syncing}
              expanded={expandedId === reg.id}
              onToggleExpand={() => setExpandedId(expandedId === reg.id ? null : reg.id)}
              syncedAgents={syncedAgents[reg.id] ?? []}
            />
          ))}
        </div>
      )}

      <AddRegistryModal open={showAdd} onClose={() => setShowAdd(false)} onAdd={handleAdd} />
    </div>
  );
}
