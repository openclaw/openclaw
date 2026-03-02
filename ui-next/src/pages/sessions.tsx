import {
  FileText,
  RotateCcw,
  Archive,
  Search,
  MessageSquare,
  SlidersHorizontal,
  ChevronRight,
  ChevronDown,
  Users,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { TeamsPanel } from "@/components/teams/teams-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data";
import { useGateway } from "@/hooks/use-gateway";
import { useTeamRuns } from "@/hooks/use-teams";
import { useGatewayStore } from "@/store/gateway-store";

type SessionKind = "direct" | "group" | "global" | "unknown";

type SessionEntry = {
  key: string;
  kind: SessionKind;
  label?: string;
  displayName?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  derivedTitle?: string;
  lastMessage?: string;
  [k: string]: unknown;
};

type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  sessions: SessionEntry[];
};

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatTokens(row: SessionEntry): string {
  if (row.totalTokens == null) {
    return "—";
  }
  const total = row.totalTokens ?? 0;
  const ctx = row.contextTokens ?? 0;
  return ctx ? `${total} / ${ctx}` : String(total);
}

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off" },
  { value: "on", label: "on" },
  { value: "full", label: "full" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

function isBinaryThinkingProvider(provider?: string | null): boolean {
  if (!provider) {
    return false;
  }
  const n = provider.trim().toLowerCase();
  return n === "zai" || n === "z.ai" || n === "z-ai";
}

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current || options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current || options.some((o) => o.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: `${current} (custom)` }];
}

const SEL =
  "h-6 rounded border border-input bg-transparent px-1 text-[11px] font-mono text-muted-foreground outline-none focus-visible:border-ring cursor-pointer";

export function SessionsPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [storePath, setStorePath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeMinutes, setActiveMinutes] = useState("");
  const [limit, setLimit] = useState("");
  const [teamsOpen, setTeamsOpen] = useState(true);
  const [includeGlobal, setIncludeGlobal] = useState(false);
  const [includeUnknown, setIncludeUnknown] = useState(false);

  // Build a sessionKey -> teamName map from active team runs for O(1) lookups
  const { teamRuns } = useTeamRuns({ state: "active" });
  const sessionTeamMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of teamRuns) {
      for (const member of run.members) {
        map.set(member.sessionKey, run.name);
      }
    }
    return map;
  }, [teamRuns]);

  // Clear the URL ?search= param once consumed so it doesn't persist on refresh
  useEffect(() => {
    if (searchParams.has("search")) {
      setSearchParams({}, { replace: true });
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        includeDerivedTitles: true,
        includeLastMessage: true,
        includeGlobal,
        includeUnknown,
      };
      const mins = Number(activeMinutes);
      if (mins > 0) {
        params.activeMinutes = mins;
      }
      const lim = Number(limit);
      if (lim > 0) {
        params.limit = lim;
      }
      const result = await sendRpc<SessionsListResult>("sessions.list", params);
      setSessions(result?.sessions ?? []);
      setStorePath(result?.path ?? "");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sendRpc, includeGlobal, includeUnknown, activeMinutes, limit]);

  useEffect(() => {
    if (isConnected) {
      void loadSessions();
    }
  }, [isConnected, loadSessions]);

  const handleReset = useCallback(
    async (key: string) => {
      const confirmed = window.confirm(
        `Reset session "${key}"?\n\nThis will clear all messages but keep session settings (model, thinking level, etc.).`,
      );
      if (!confirmed) {
        return;
      }
      setActionLoading(key);
      try {
        await sendRpc("sessions.reset", { key });
        await loadSessions();
      } catch (err) {
        setError(String(err));
      } finally {
        setActionLoading(null);
      }
    },
    [sendRpc, loadSessions],
  );

  const handleDelete = useCallback(
    async (key: string) => {
      const confirmed = window.confirm(
        `Delete session "${key}"?\n\nDeletes the session entry and archives its transcript.`,
      );
      if (!confirmed) {
        return;
      }
      setActionLoading(key);
      try {
        await sendRpc("sessions.delete", { key, deleteTranscript: true });
        await loadSessions();
      } catch (err) {
        setError(String(err));
      } finally {
        setActionLoading(null);
      }
    },
    [sendRpc, loadSessions],
  );

  const handleCompact = useCallback(
    async (key: string) => {
      setActionLoading(key);
      try {
        await sendRpc("sessions.compact", { key });
        await loadSessions();
      } catch (err) {
        setError(String(err));
      } finally {
        setActionLoading(null);
      }
    },
    [sendRpc, loadSessions],
  );

  const handlePatch = useCallback(
    async (
      key: string,
      patch: {
        label?: string | null;
        thinkingLevel?: string | null;
        verboseLevel?: string | null;
        reasoningLevel?: string | null;
      },
    ) => {
      try {
        await sendRpc("sessions.patch", { key, ...patch });
        await loadSessions();
      } catch (err) {
        setError(String(err));
      }
    },
    [sendRpc, loadSessions],
  );

  const filtered = search
    ? sessions.filter((s) => {
        const q = search.toLowerCase();
        return (
          s.key.toLowerCase().includes(q) ||
          s.derivedTitle?.toLowerCase().includes(q) ||
          s.label?.toLowerCase().includes(q) ||
          s.displayName?.toLowerCase().includes(q) ||
          s.subject?.toLowerCase().includes(q)
        );
      })
    : sessions;

  const columns: Column<SessionEntry>[] = [
    {
      key: "key",
      header: "Key",
      sortable: true,
      render: (row) => {
        const showDisplayName =
          row.displayName && row.displayName !== row.key && row.displayName !== row.label;
        const teamName = sessionTeamMap.get(row.key);
        return (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-sm text-primary">{row.key}</span>
              {teamName && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  <Users className="h-3 w-3 mr-0.5" />
                  {teamName}
                </Badge>
              )}
            </div>
            {showDisplayName && (
              <span className="text-[11px] text-muted-foreground">{row.displayName}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "label",
      header: "Label",
      className: "w-36",
      render: (row) => (
        <input
          className="h-7 w-full rounded border border-input bg-transparent px-2 text-xs outline-none focus:border-ring placeholder:text-muted-foreground/50"
          defaultValue={row.label ?? ""}
          placeholder="(optional)"
          disabled={!!actionLoading}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (row.label ?? "")) {
              void handlePatch(row.key, { label: v || null });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      ),
    },
    {
      key: "kind",
      header: "Kind",
      className: "w-16",
      render: (row) => <span className="text-xs text-muted-foreground">{row.kind}</span>,
    },
    {
      key: "updatedAt",
      header: "Updated",
      sortable: true,
      className: "w-20",
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {row.updatedAt ? formatRelativeTime(row.updatedAt) : "—"}
        </span>
      ),
    },
    {
      key: "totalTokens",
      header: "Tokens",
      className: "w-20",
      render: (row) => (
        <span className="text-xs font-mono text-muted-foreground">{formatTokens(row)}</span>
      ),
    },
    {
      key: "thinkingLevel",
      header: "Thinking",
      className: "w-24",
      render: (row) => {
        const isBinary = isBinaryThinkingProvider(row.modelProvider);
        const raw = row.thinkingLevel ?? "";
        const display = isBinary && raw && raw !== "off" ? "on" : raw;
        const options = isBinary ? BINARY_THINK_LEVELS : THINK_LEVELS;
        const opts = withCurrentOption([...options], display);
        return (
          <select
            className={SEL}
            value={display}
            disabled={!!actionLoading}
            onChange={(e) => {
              const v = e.target.value;
              let patch: string | null = v || null;
              if (isBinary && v === "on") {
                patch = "low";
              }
              void handlePatch(row.key, { thinkingLevel: patch });
            }}
          >
            {opts.map((level) => (
              <option key={level} value={level}>
                {level || "inherit"}
              </option>
            ))}
          </select>
        );
      },
    },
    {
      key: "verboseLevel",
      header: "Verbose",
      className: "w-24",
      render: (row) => {
        const current = row.verboseLevel ?? "";
        const opts = withCurrentLabeledOption(VERBOSE_LEVELS, current);
        return (
          <select
            className={SEL}
            value={current}
            disabled={!!actionLoading}
            onChange={(e) => handlePatch(row.key, { verboseLevel: e.target.value || null })}
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      },
    },
    {
      key: "reasoningLevel",
      header: "Reasoning",
      className: "w-24",
      render: (row) => {
        const current = row.reasoningLevel ?? "";
        const opts = withCurrentOption([...REASONING_LEVELS], current);
        return (
          <select
            className={SEL}
            value={current}
            disabled={!!actionLoading}
            onChange={(e) => handlePatch(row.key, { reasoningLevel: e.target.value || null })}
          >
            {opts.map((level) => (
              <option key={level} value={level}>
                {level || "inherit"}
              </option>
            ))}
          </select>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      className: "w-20",
      render: (row) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              void handleReset(row.key);
            }}
            disabled={actionLoading === row.key}
            title="Reset session"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              void handleCompact(row.key);
            }}
            disabled={actionLoading === row.key}
            title="Compact transcript"
          >
            <Archive className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete(row.key);
            }}
            disabled={actionLoading === row.key}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-mono font-semibold">Sessions</h1>
          <span className="text-xs font-mono text-muted-foreground">{sessions.length} total</span>
        </div>
        <Button variant="outline" size="sm" onClick={loadSessions} disabled={loading}>
          <RotateCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Teams section (collapsible) */}
      {isConnected && (
        <div className="rounded-lg border bg-card">
          <button
            onClick={() => setTeamsOpen(!teamsOpen)}
            className="flex w-full items-center justify-between p-3 hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-2">
              {teamsOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <Users className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">Teams</span>
            </div>
          </button>
          {teamsOpen && (
            <div className="border-t px-3 pb-3 pt-2">
              <TeamsPanel />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-56 rounded-md border border-input bg-transparent pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center gap-3">
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Active (min)</span>
            <input
              type="number"
              min={0}
              value={activeMinutes}
              onChange={(e) => setActiveMinutes(e.target.value)}
              placeholder="all"
              className="h-7 w-16 rounded border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Limit</span>
            <input
              type="number"
              min={0}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              className="h-7 w-16 rounded border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeGlobal}
              onChange={(e) => setIncludeGlobal(e.target.checked)}
              className="accent-primary"
            />
            <span>Global</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeUnknown}
              onChange={(e) => setIncludeUnknown(e.target.checked)}
              className="accent-primary"
            />
            <span>Unknown</span>
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={loadSessions}
            disabled={loading}
          >
            Apply
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-destructive/70 hover:text-destructive text-xs ml-2"
          >
            dismiss
          </button>
        </div>
      )}

      {storePath && (
        <p className="text-[11px] text-muted-foreground font-mono">Store: {storePath}</p>
      )}

      {!isConnected ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Connect to the gateway to view sessions</p>
        </div>
      ) : (
        <div className={loading ? "opacity-60 pointer-events-none" : ""}>
          <DataTable
            columns={columns}
            data={filtered}
            keyField="key"
            emptyMessage={search ? "No matching sessions" : "No sessions found"}
            className="[&_tr]:group"
          />
        </div>
      )}
    </div>
  );
}
