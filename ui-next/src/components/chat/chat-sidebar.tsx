import {
  Search,
  Plus,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Archive,
  ArchiveRestore,
  Pencil,
  Pin,
  PinOff,
  Filter,
} from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { TextShimmerLoader } from "@/components/ui/custom/prompt/loader";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useChatStore, type SessionEntry } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";
import type { AgentRow } from "@/types/agents";

// ─── Constants ───

const PINNED_STORAGE_KEY = "openclaw.chat.pinnedSessions";

// ─── Helpers ───

/** Strip leading bracketed prefix (e.g., "[Fri 2026-02-13 20:20 GMT+5:30]") from strings. */
function stripBracketedPrefix(s: string): string {
  const stripped = s.replace(/^\[[^\]]*\]\s*/, "");
  return stripped.trim() || s;
}

export function formatSessionTitle(session: SessionEntry): string {
  if (session.label) {
    return session.label;
  }
  if (session.derivedTitle) {
    return stripBracketedPrefix(session.derivedTitle);
  }
  const keyContent = stripBracketedPrefix(session.key);
  if (keyContent !== session.key && keyContent.length > 0) {
    return keyContent;
  }
  if (session.lastMessage) {
    return session.lastMessage.trim();
  }
  const key = session.key;
  if (key.includes(":")) {
    const parts = key.split(":");
    return parts[parts.length - 1] || key;
  }
  return key;
}

function groupSessionsByTime(sessions: SessionEntry[]): Record<string, SessionEntry[]> {
  const now = Date.now();
  const day = 86400000;
  const groups: Record<string, SessionEntry[]> = {};

  for (const s of sessions) {
    const lastActive = s.lastActiveMs ?? 0;
    const age = now - lastActive;
    let group: string;
    if (age < day) {
      group = "Today";
    } else if (age < 2 * day) {
      group = "Yesterday";
    } else if (age < 7 * day) {
      group = "7 Days Ago";
    } else {
      group = "Older";
    }

    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(s);
  }

  return groups;
}

/** Format a relative timestamp like "2h ago", "3d ago", etc. */
function formatRelativeTime(ms: number): string {
  if (!ms) {
    return "";
  }
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) {
    return "just now";
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return "just now";
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
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Format token count compactly. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

/** Get the agent ID from a session, checking both agentId field and key prefix. */
function getSessionAgentId(session: SessionEntry): string | undefined {
  if (session.agentId) {
    return session.agentId;
  }
  if (session.key.startsWith("agent:")) {
    return session.key.split(":")[1];
  }
  return undefined;
}

/** Get the channel from a session entry. */
function getSessionChannel(session: SessionEntry): string | undefined {
  return (session.channel as string | undefined) ?? undefined;
}

/** Load pinned session keys from localStorage. */
function loadPinnedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr);
    }
  } catch {
    // ignore
  }
  return new Set();
}

/** Save pinned session keys to localStorage. */
function savePinnedKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // ignore
  }
}

// ─── Hook: useSidebarAgentMap ───

function useSidebarAgentMap() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const [agentMap, setAgentMap] = useState<Map<string, AgentRow>>(new Map());

  useEffect(() => {
    if (!isConnected) {
      return;
    }
    sendRpc<{ agents: AgentRow[] }>("agents.list")
      .then((res) => {
        if (!res?.agents) {
          return;
        }
        const m = new Map<string, AgentRow>();
        for (const a of res.agents) {
          m.set(a.id, a);
        }
        setAgentMap(m);
      })
      .catch(() => {});
  }, [isConnected, sendRpc]);

  return agentMap;
}

// ─── Filter types ───

type FilterType = "all" | "agent" | "channel";
type FilterValue = { type: FilterType; value?: string; label: string };

// ─── Session Sidebar ───

export function SessionSidebarContent({
  onSelect,
  activeKey,
  onNewChat,
  onReset,
  onDelete,
  onRename,
  onArchive,
  collapsed = false,
  onCollapse,
}: {
  onSelect: (key: string) => void;
  activeKey: string;
  onNewChat: () => void;
  onReset: (key: string) => void;
  onDelete: (key: string) => void;
  onRename: (key: string, newLabel: string) => void;
  onArchive?: (key: string, archive: boolean) => Promise<void>;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
}) {
  const sessions = useChatStore((s) => s.sessions);
  const loading = useChatStore((s) => s.sessionsLoading);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Agent map for emoji/name display
  const agentMap = useSidebarAgentMap();

  // Pinned sessions
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(loadPinnedKeys);

  const togglePin = useCallback((key: string) => {
    setPinnedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      savePinnedKeys(next);
      return next;
    });
  }, []);

  // Active filter
  const [activeFilter, setActiveFilter] = useState<FilterValue>({ type: "all", label: "All" });

  // Derive available filters from session data
  const availableFilters = useMemo(() => {
    const filters: FilterValue[] = [{ type: "all", label: "All" }];
    const agentIds = new Set<string>();
    const channels = new Set<string>();

    for (const s of sessions) {
      const aid = getSessionAgentId(s);
      if (aid) {
        agentIds.add(aid);
      }
      const ch = getSessionChannel(s);
      if (ch) {
        channels.add(ch);
      }
    }

    for (const aid of agentIds) {
      const agent = agentMap.get(aid);
      const emoji = agent?.identity?.emoji;
      const name = agent?.identity?.name ?? agent?.name ?? aid;
      const label = emoji ? `${emoji} ${name}` : name;
      filters.push({ type: "agent", value: aid, label });
    }

    for (const ch of channels) {
      filters.push({ type: "channel", value: ch, label: ch });
    }

    return filters;
  }, [sessions, agentMap]);

  // Archived sessions state
  const { sendRpc: sidebarRpc } = useGateway();
  const [archivedSessions, setArchivedSessions] = useState<SessionEntry[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);

  const loadArchivedSessions = useCallback(async () => {
    setArchiveLoading(true);
    try {
      const result = await sidebarRpc<{ sessions: SessionEntry[] }>("sessions.list", {
        archivedOnly: true,
        limit: 50,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      setArchivedSessions(result?.sessions ?? []);
    } catch {
      // silently fail
    } finally {
      setArchiveLoading(false);
    }
  }, [sidebarRpc]);

  // Fetch archived sessions when section is expanded
  useEffect(() => {
    if (showArchived) {
      void loadArchivedSessions();
    }
  }, [showArchived, loadArchivedSessions]);

  // Close menu/confirmations when clicking outside
  useEffect(() => {
    if (menuOpen === null && confirmDelete === null && confirmReset === null) {
      return;
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(null);
        setConfirmDelete(null);
        setConfirmReset(null);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [menuOpen, confirmDelete, confirmReset]);

  // Apply search + filter
  const filteredSessions = useMemo(() => {
    let result = sessions;

    // Apply active filter
    if (activeFilter.type === "agent" && activeFilter.value) {
      const aid = activeFilter.value;
      result = result.filter((s) => getSessionAgentId(s) === aid);
    } else if (activeFilter.type === "channel" && activeFilter.value) {
      const ch = activeFilter.value;
      result = result.filter((s) => getSessionChannel(s) === ch);
    }

    // Apply search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((s) => {
        const title = formatSessionTitle(s).toLowerCase();
        const msg = (s.lastMessage ?? "").toLowerCase();
        return title.includes(q) || msg.includes(q);
      });
    }

    return result;
  }, [sessions, searchQuery, activeFilter]);

  // Split into pinned vs unpinned
  const pinnedSessions = useMemo(
    () => filteredSessions.filter((s) => pinnedKeys.has(s.key)),
    [filteredSessions, pinnedKeys],
  );
  const unpinnedSessions = useMemo(
    () => filteredSessions.filter((s) => !pinnedKeys.has(s.key)),
    [filteredSessions, pinnedKeys],
  );

  const grouped = useMemo(() => groupSessionsByTime(unpinnedSessions), [unpinnedSessions]);
  const groupOrder = ["Today", "Yesterday", "7 Days Ago", "Older"];

  // Show filter row only when there are multiple filter options
  const showFilters = !collapsed && availableFilters.length > 1;

  /** Render a single session row with metadata. */
  const renderSessionRow = (session: SessionEntry, isPinned?: boolean) => {
    const agentId = getSessionAgentId(session);
    const agent = agentId ? agentMap.get(agentId) : undefined;
    const agentEmoji = agent?.identity?.emoji;
    const channel = getSessionChannel(session);
    const totalTokens =
      (session.tokenCounts?.totalInput ?? 0) + (session.tokenCounts?.totalOutput ?? 0);
    const relTime = formatRelativeTime(session.lastActiveMs ?? 0);

    return (
      <div key={session.key} className="relative group/item" role="listitem">
        <button
          onClick={() => onSelect(session.key)}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-all duration-200",
            "hover:bg-accent/40",
            activeKey === session.key
              ? "bg-accent/60 text-foreground font-medium shadow-sm ring-1 ring-border/50"
              : "text-muted-foreground",
          )}
        >
          <MessageSquare
            className={cn(
              "h-4 w-4 shrink-0 mt-0.5 transition-colors",
              activeKey === session.key ? "text-primary" : "text-muted-foreground/70",
            )}
          />
          <div className="flex-1 min-w-0">
            {renamingKey === session.key ? (
              <input
                ref={renameInputRef}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameValue.trim()) {
                    onRename(session.key, renameValue.trim());
                    setRenamingKey(null);
                  }
                  if (e.key === "Escape") {
                    setRenamingKey(null);
                  }
                }}
                onBlur={() => {
                  if (renameValue.trim()) {
                    onRename(session.key, renameValue.trim());
                  }
                  setRenamingKey(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 text-sm bg-transparent border-b border-primary/50 outline-none text-foreground placeholder:text-muted-foreground/50 w-full"
                placeholder="Session name..."
              />
            ) : (
              <>
                {/* Title row with agent emoji */}
                <div className="flex items-center gap-1.5 min-w-0">
                  {agentEmoji && (
                    <span className="text-xs shrink-0" title={agent?.identity?.name ?? agent?.name}>
                      {agentEmoji}
                    </span>
                  )}
                  {isPinned && <Pin className="h-3 w-3 shrink-0 text-primary/50" />}
                  <span className="truncate text-sm">{formatSessionTitle(session)}</span>
                </div>
                {/* Metadata row */}
                <div className="flex items-center gap-1.5 mt-0.5">
                  {channel && (
                    <span className="text-[10px] px-1 py-px rounded bg-muted/60 text-muted-foreground/70 font-medium shrink-0">
                      {channel}
                    </span>
                  )}
                  {totalTokens > 0 && (
                    <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
                      {formatTokens(totalTokens)} tokens
                    </span>
                  )}
                  {relTime && (
                    <span className="text-[10px] text-muted-foreground/40 ml-auto shrink-0">
                      {relTime}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </button>

        {/* Hover Menu */}
        <div
          ref={
            menuOpen === session.key ||
            confirmDelete === session.key ||
            confirmReset === session.key
              ? menuRef
              : undefined
          }
          className={cn(
            "absolute right-2 top-3 transition-opacity",
            menuOpen === session.key ||
              confirmDelete === session.key ||
              confirmReset === session.key
              ? "opacity-100 z-50"
              : "opacity-0 group-hover/item:opacity-100",
          )}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 bg-background/80 backdrop-blur-sm shadow-sm ring-1 ring-border/50"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(menuOpen === session.key ? null : session.key);
              setConfirmDelete(null);
              setConfirmReset(null);
            }}
            aria-label="Session options"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>

          {menuOpen === session.key && (
            <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-xl border border-border bg-popover/95 backdrop-blur-md p-1 shadow-lg animate-in fade-in zoom-in-95 duration-100 origin-top-right">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(null);
                  togglePin(session.key);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted font-medium transition-colors"
              >
                {pinnedKeys.has(session.key) ? (
                  <>
                    <PinOff className="h-3.5 w-3.5" />
                    Unpin
                  </>
                ) : (
                  <>
                    <Pin className="h-3.5 w-3.5" />
                    Pin
                  </>
                )}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(null);
                  setRenamingKey(session.key);
                  setRenameValue(formatSessionTitle(session));
                  setTimeout(() => renameInputRef.current?.select(), 0);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted font-medium transition-colors"
              >
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(null);
                  setConfirmReset(session.key);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted font-medium transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
              {onArchive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(null);
                    void onArchive(session.key, true).then(() => loadArchivedSessions());
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted font-medium transition-colors"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archive
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(null);
                  setConfirmDelete(session.key);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 font-medium transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          )}

          {/* Inline reset confirmation */}
          {confirmReset === session.key && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-border/30 bg-popover/95 backdrop-blur-md p-2 shadow-lg animate-in fade-in zoom-in-95 duration-100 origin-top-right">
              <p className="text-xs text-foreground mb-2 px-1">Reset this session?</p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmReset(null);
                  }}
                  className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-muted hover:bg-muted/80 transition-colors text-center"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReset(session.key);
                    setConfirmReset(null);
                  }}
                  className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-center"
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {/* Inline delete confirmation */}
          {confirmDelete === session.key && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-destructive/30 bg-popover/95 backdrop-blur-md p-2 shadow-lg animate-in fade-in zoom-in-95 duration-100 origin-top-right">
              <p className="text-xs text-foreground mb-2 px-1">Delete this session?</p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(null);
                  }}
                  className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-muted hover:bg-muted/80 transition-colors text-center"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.key);
                    setConfirmDelete(null);
                  }}
                  className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors text-center"
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-card/30 min-h-0">
      {/* Header with collapse toggle */}
      <div
        className={cn(
          "flex items-center border-b border-border/40 shrink-0",
          collapsed ? "justify-center px-2 py-3" : "justify-between px-4 py-3",
        )}
      >
        {!collapsed && (
          <span className="text-sm font-semibold text-foreground/80 tracking-tight">History</span>
        )}
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => onCollapse(!collapsed)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronsLeft className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        )}
      </div>

      {/* Search (hidden when collapsed) */}
      {!collapsed && (
        <div className="px-3 py-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
            <input
              type="text"
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search chats"
              className="h-9 w-full rounded-lg border border-border/50 bg-background/50 pl-9 pr-3 text-sm placeholder:text-muted-foreground/70 outline-none focus:border-primary/30 focus:ring-1 focus:ring-primary/10 transition-colors"
            />
          </div>
        </div>
      )}

      {/* Filter chips (hidden when collapsed) */}
      {showFilters && (
        <div className="px-3 pb-2 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
            {availableFilters.map((filter) => {
              const isActive =
                activeFilter.type === filter.type && activeFilter.value === filter.value;
              return (
                <button
                  key={`${filter.type}:${filter.value ?? "all"}`}
                  onClick={() => setActiveFilter(filter)}
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors whitespace-nowrap",
                    isActive
                      ? "bg-primary/15 text-primary ring-1 ring-primary/20"
                      : "bg-muted/50 text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground",
                  )}
                >
                  {filter.type === "channel" && (
                    <Filter className="inline h-2.5 w-2.5 mr-0.5 -mt-px" />
                  )}
                  {filter.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Session list -- scrollable */}
      <nav
        className={cn(
          "flex-1 overflow-y-auto min-h-0 py-1",
          collapsed ? "px-1.5" : "px-3 space-y-6",
        )}
        role="list"
        aria-label="Chat sessions"
      >
        {loading && sessions.length === 0 ? (
          <div className="px-3 py-4 text-center">
            {!collapsed && <TextShimmerLoader text="Loading..." size="sm" />}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {!collapsed && (searchQuery ? "No matching chats" : "No sessions yet")}
          </div>
        ) : collapsed ? (
          /* Collapsed: icon-only session list with numbered badges */
          <div className="space-y-0.5 py-1">
            {filteredSessions.map((session, idx) => (
              <div key={session.key} className="relative group" role="listitem">
                <button
                  onClick={() => onSelect(session.key)}
                  aria-label={formatSessionTitle(session)}
                  className={cn(
                    "flex w-full items-center justify-center rounded-md py-2 transition-colors",
                    activeKey === session.key
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span className="relative flex items-center justify-center h-6 w-6">
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    <span className="absolute -bottom-0.5 -right-0.5 text-[8px] font-bold leading-none bg-background rounded-full h-3 w-3 flex items-center justify-center ring-1 ring-border/50">
                      {idx + 1}
                    </span>
                  </span>
                </button>
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:block">
                  <div className="rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md whitespace-nowrap max-w-[200px] truncate">
                    {formatSessionTitle(session)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Expanded: full session list with pinned + groups + archived */
          <>
            {/* Pinned section */}
            {pinnedSessions.length > 0 && (
              <div>
                <div className="flex items-center gap-1 px-2 mb-2">
                  <Pin className="h-3 w-3 text-muted-foreground/50" />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                    Pinned
                  </span>
                </div>
                <div className="space-y-0.5">
                  {pinnedSessions.map((session) => renderSessionRow(session, true))}
                </div>
              </div>
            )}

            {/* Time-grouped sections */}
            {groupOrder.map((group) => {
              const items = grouped[group];
              if (!items?.length) {
                return null;
              }
              return (
                <div key={group}>
                  <div className="px-2 mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                    {group}
                  </div>
                  <div className="space-y-0.5">
                    {items.map((session) => renderSessionRow(session))}
                  </div>
                </div>
              );
            })}

            {/* Archived Sessions */}
            {onArchive && (
              <div className="mt-4 border-t border-border/30 pt-3">
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className="flex w-full items-center gap-2 px-2 mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  {showArchived ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Archived
                  {archivedSessions.length > 0 && (
                    <span className="ml-auto text-[9px] bg-muted rounded-full px-1.5 py-0.5">
                      {archivedSessions.length}
                    </span>
                  )}
                </button>
                {showArchived && (
                  <div className="space-y-0.5">
                    {archiveLoading ? (
                      <div className="px-3 py-2 text-center">
                        <TextShimmerLoader text="Loading..." size="sm" />
                      </div>
                    ) : archivedSessions.length === 0 ? (
                      <div className="px-3 py-2 text-center text-xs text-muted-foreground/50">
                        No archived sessions
                      </div>
                    ) : (
                      archivedSessions.map((session) => (
                        <div key={session.key} className="relative group/item" role="listitem">
                          <button
                            onClick={() => onSelect(session.key)}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all duration-200",
                              "hover:bg-accent/30 opacity-60 hover:opacity-80",
                              activeKey === session.key &&
                                "bg-accent/40 opacity-80 ring-1 ring-border/50",
                            )}
                          >
                            <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                            <span className="truncate text-xs text-muted-foreground">
                              {formatSessionTitle(session)}
                            </span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void onArchive(session.key, false).then(() =>
                                loadArchivedSessions(),
                              );
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/item:opacity-100 transition-opacity"
                            title="Unarchive"
                          >
                            <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      {/* New Chat button */}
      <div className={cn("border-t border-border/40 shrink-0", collapsed ? "px-1.5 py-2" : "p-4")}>
        {collapsed ? (
          <div className="relative group">
            <button
              onClick={onNewChat}
              className="flex w-full items-center justify-center rounded-md py-2 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:block">
              <div className="rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md whitespace-nowrap">
                New Chat
              </div>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full justify-start gap-3 rounded-xl h-11 border-dashed border-border/60 hover:border-primary/50 hover:bg-primary/5 transition-all text-muted-foreground hover:text-primary"
            onClick={onNewChat}
          >
            <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
              <Plus className="h-4 w-4" />
            </div>
            New Chat
          </Button>
        )}
      </div>
    </div>
  );
}
