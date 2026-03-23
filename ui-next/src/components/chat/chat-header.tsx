import { Check, Minimize2, Archive, Pencil, Search, Copy } from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { formatSessionTitle } from "@/components/chat/chat-sidebar";
import { SessionHeaderBadges } from "@/components/chat/session-badges";
import { type ModelEntry } from "@/components/ui/custom/status/model-selector";
import { useToast } from "@/components/ui/custom/toast";
import { Separator } from "@/components/ui/separator";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";
import type { AgentRow } from "@/types/agents";

// ─── Hook: useAgentMap ───

export function useAgentMap() {
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

/** Derive the active agent ID from the current session. */
export function useActiveAgentId(): string | undefined {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  return useMemo(() => {
    const session = sessions.find((s) => s.key === activeSessionKey);
    return (
      session?.agentId ??
      (activeSessionKey?.startsWith("agent:") ? activeSessionKey.split(":")[1] : undefined)
    );
  }, [sessions, activeSessionKey]);
}

export function useActiveAgentEmoji(agentMap: Map<string, AgentRow>) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  const activeSession = useMemo(
    () => sessions.find((s) => s.key === activeSessionKey),
    [sessions, activeSessionKey],
  );

  return useMemo(() => {
    if (agentMap.size === 0) {
      return undefined;
    }
    const id =
      activeSession?.agentId ??
      (activeSessionKey?.startsWith("agent:") ? activeSessionKey.split(":")[1] : undefined);
    if (!id) {
      return undefined;
    }
    return agentMap.get(id)?.identity?.emoji;
  }, [activeSession?.agentId, activeSessionKey, agentMap]);
}

export function useActiveAgentLabel(agentMap: Map<string, AgentRow>) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  return useMemo(() => {
    if (agentMap.size === 0) {
      return undefined;
    }
    const session = sessions.find((s) => s.key === activeSessionKey);
    const id =
      session?.agentId ??
      (activeSessionKey?.startsWith("agent:") ? activeSessionKey.split(":")[1] : undefined);
    if (!id) {
      return undefined;
    }
    const agent = agentMap.get(id);
    if (!agent) {
      return undefined;
    }
    const name = agent.identity?.name ?? agent.name ?? id;
    const emoji = agent.identity?.emoji;
    return emoji ? `${emoji} ${name}` : name;
  }, [agentMap, sessions, activeSessionKey]);
}

export function useActiveAgentName(agentMap: Map<string, AgentRow>) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  return useMemo(() => {
    if (agentMap.size === 0) {
      return undefined;
    }
    const session = sessions.find((s) => s.key === activeSessionKey);
    const id =
      session?.agentId ??
      (activeSessionKey?.startsWith("agent:") ? activeSessionKey.split(":")[1] : undefined);
    if (!id) {
      return undefined;
    }
    const agent = agentMap.get(id);
    if (!agent) {
      return undefined;
    }
    return agent.identity?.name ?? agent.name ?? id;
  }, [agentMap, sessions, activeSessionKey]);
}

export function useActiveAgentMeta(agentMap: Map<string, AgentRow>) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  return useMemo(() => {
    if (agentMap.size === 0) {
      return { role: undefined, department: undefined };
    }
    const session = sessions.find((s) => s.key === activeSessionKey);
    const id =
      session?.agentId ??
      (activeSessionKey?.startsWith("agent:") ? activeSessionKey.split(":")[1] : undefined);
    if (!id) {
      return { role: undefined, department: undefined };
    }
    const agent = agentMap.get(id);
    return {
      role: agent?.role,
      department: agent?.department,
    };
  }, [agentMap, sessions, activeSessionKey]);
}

// ─── ChatHeader ───

export type ChatHeaderProps = {
  models: ModelEntry[];
  loadSessions: () => Promise<void>;
  loadHistory: () => Promise<void>;
  switchSession: (key: string) => void;
  agentEmoji?: string;
  agentName?: string;
  agentRole?: string;
  agentDepartment?: string;
  onRenameSession?: (key: string, newLabel: string) => void;
  onToggleSearch?: () => void;
  isSearchOpen?: boolean;
};

export function ChatHeader({
  models,
  loadSessions,
  loadHistory,
  switchSession,
  agentEmoji,
  agentName,
  agentRole,
  agentDepartment,
  onRenameSession,
  onToggleSearch,
  isSearchOpen,
}: ChatHeaderProps) {
  const { sendRpc } = useGateway();
  const { toast } = useToast();
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  const activeSession = useMemo(
    () => sessions.find((s) => s.key === activeSessionKey),
    [sessions, activeSessionKey],
  );

  // Context window usage — used to gate the compact button
  const tokenUsed =
    (activeSession?.totalTokens as number | undefined) ??
    ((activeSession?.inputTokens as number | undefined) ??
      activeSession?.tokenCounts?.totalInput ??
      0) +
      ((activeSession?.outputTokens as number | undefined) ??
        activeSession?.tokenCounts?.totalOutput ??
        0);
  const sessionTitle = activeSession ? formatSessionTitle(activeSession) : "New Chat";

  // Smart compaction
  const [compactingSessionKey, setCompactingSessionKey] = useState<string | null>(null);
  const isCompacting = compactingSessionKey === activeSessionKey;
  const handleCompact = useCallback(async () => {
    if (!activeSessionKey || compactingSessionKey !== null) {
      return;
    }
    const sessionKey = activeSessionKey;
    setCompactingSessionKey(sessionKey);
    try {
      const res = await sendRpc<{
        compacted?: boolean;
        reason?: string;
        tokensBefore?: number;
        tokensAfter?: number;
        summary?: string;
      }>("sessions.compactSmart", { sessionKey });
      if (res?.compacted) {
        const before = res.tokensBefore ?? 0;
        const after = res.tokensAfter ?? 0;
        const pct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
        const saved = before > 0 && after > 0 ? ` ${before} → ${after} tokens (${pct}% saved)` : "";
        toast(`Compacted:${saved}`, "success");
        await loadHistory();
      } else {
        const detail = res?.reason ?? "already compact";
        toast(`Nothing to compact (${detail})`, "success");
      }
    } catch (err) {
      console.error("[compact] smart compaction error:", err);
      toast(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setCompactingSessionKey(null);
    }
  }, [activeSessionKey, compactingSessionKey, sendRpc, toast, loadHistory]);

  // Archive
  const [isArchiving, setIsArchiving] = useState(false);
  const handleArchive = useCallback(async () => {
    if (!activeSessionKey || isArchiving) {
      return;
    }
    const confirmed = window.confirm(
      "Archive this session?\n\nIt will be hidden from the active list but the transcript stays on disk for memory search.",
    );
    if (!confirmed) {
      return;
    }
    setIsArchiving(true);
    try {
      await sendRpc("sessions.archive", { key: activeSessionKey, archived: true });
      await loadSessions();
      const store = useChatStore.getState();
      const remaining = store.sessions;
      const fallback = remaining[0]?.key ?? "main";
      switchSession(fallback);
      toast("Session archived", "success");
    } catch (err) {
      toast(`Archive failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setIsArchiving(false);
    }
  }, [activeSessionKey, isArchiving, sendRpc, loadSessions, switchSession, toast]);

  // Copy session details to clipboard
  const handleCopyChat = useCallback(() => {
    const store = useChatStore.getState();
    const sessionKey = store.activeSessionKey;
    if (!sessionKey) {
      toast("No active session", "error");
      return;
    }
    const sessionState = store.getSessionState(sessionKey);
    const entry = store.sessions.find((s) => s.key === sessionKey);
    const msgCount = sessionState.messages.length;
    const firstMsg = sessionState.messages[0];
    const lastMsg = sessionState.messages[msgCount - 1];
    const startTime = firstMsg?.timestamp
      ? new Date(firstMsg.timestamp).toISOString().slice(0, 19)
      : "—";
    const lastTime = lastMsg?.timestamp
      ? new Date(lastMsg.timestamp).toISOString().slice(0, 19)
      : "—";

    // Extract channel from session key (agent:main:telegram:group:... → telegram)
    const keyParts = sessionKey.split(":");
    const channel = keyParts.length >= 3 ? keyParts[2] : "web";

    // Find last assistant message
    const lastAssistantMsg = [...sessionState.messages]
      .toReversed()
      .find((m) => m.role === "assistant");
    let lastAssistantText = "—";
    if (lastAssistantMsg) {
      if (typeof lastAssistantMsg.content === "string") {
        lastAssistantText = lastAssistantMsg.content.slice(0, 150);
      } else if (Array.isArray(lastAssistantMsg.content)) {
        const textBlock = lastAssistantMsg.content.find(
          (b: Record<string, unknown>) => b.type === "text",
        ) as { text?: string } | undefined;
        lastAssistantText = (textBlock?.text ?? "").slice(0, 150);
      }
    }

    const totalInput = entry?.tokenCounts?.totalInput ?? 0;
    const totalOutput = entry?.tokenCounts?.totalOutput ?? 0;

    const lines = [
      `Session Key: ${sessionKey}`,
      entry?.sessionId ? `Session ID: ${entry.sessionId}` : null,
      entry?.agentId ? `Agent: ${entry.agentId}` : null,
      `Channel: ${channel}`,
      entry?.model ? `Model: ${entry.model}` : null,
      entry?.derivedTitle ? `Title: ${entry.derivedTitle}` : null,
      `Messages: ${msgCount}`,
      `Tokens: ${totalInput + totalOutput} (in: ${totalInput}, out: ${totalOutput})`,
      `Started: ${startTime}`,
      `Last Activity: ${lastTime}`,
      ``,
      `Last Agent Message:`,
      lastAssistantText
        ? `  ${lastAssistantText}${lastAssistantText.length >= 150 ? "..." : ""}`
        : "  —",
    ].filter(Boolean);

    navigator.clipboard.writeText(lines.join("\n")).then(
      () => toast("Session details copied", "success"),
      () => toast("Failed to copy", "error"),
    );
  }, [toast]);

  // Shell header portal targets
  const headerPortal =
    typeof document !== "undefined" ? document.getElementById("shell-header-extra") : null;
  const titlePortal =
    typeof document !== "undefined" ? document.getElementById("shell-page-title") : null;

  // Hide default page title when we're portalling our own
  useEffect(() => {
    const defaultTitle = document.getElementById("shell-page-title-default");
    if (defaultTitle) {
      defaultTitle.style.display = "none";
    }
    return () => {
      if (defaultTitle) {
        defaultTitle.style.display = "";
      }
    };
  }, []);

  // Inline title rename
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRename = useCallback(() => {
    setRenameValue(sessionTitle);
    setIsRenamingTitle(true);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, [sessionTitle]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== sessionTitle && onRenameSession && activeSessionKey) {
      onRenameSession(activeSessionKey, trimmed);
    }
    setIsRenamingTitle(false);
  }, [renameValue, sessionTitle, onRenameSession, activeSessionKey]);

  return (
    <>
      {/* Session title replacing "Chat" in shell breadcrumb */}
      {titlePortal &&
        createPortal(
          isRenamingTitle ? (
            <span className="flex items-center gap-1.5">
              <input
                ref={renameInputRef}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitRename();
                  }
                  if (e.key === "Escape") {
                    setIsRenamingTitle(false);
                  }
                }}
                onBlur={commitRename}
                className="bg-transparent border-b border-primary/50 outline-none text-sm md:text-base font-medium text-foreground w-[200px] sm:w-[300px] py-0"
                placeholder="Session name..."
              />
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitRename();
                }}
                className="text-primary hover:text-primary/80 transition-colors"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 group/title">
              <span className="truncate max-w-[180px] sm:max-w-[300px]" title={sessionTitle}>
                {sessionTitle}
              </span>
              {onRenameSession && (
                <button
                  onClick={startRename}
                  className="opacity-0 group-hover/title:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                  aria-label="Rename session"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </span>
          ),
          titlePortal,
        )}

      {/* Action buttons injected into Shell header via portal */}
      {headerPortal &&
        createPortal(
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground min-w-0">
            {/* Session context badges: agent, session kind, project, channel */}
            {models && models.length > 0 && (
              <>
                <SessionHeaderBadges
                  models={models}
                  agentEmoji={agentEmoji}
                  agentName={agentName}
                  agentRole={agentRole}
                  agentDepartment={agentDepartment}
                />
                <Separator orientation="vertical" className="h-3.5" />
              </>
            )}
            <div className="flex items-center gap-2">
              {/* Search button */}
              {onToggleSearch && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <button
                    onClick={onToggleSearch}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0",
                      isSearchOpen
                        ? "bg-primary/20 text-primary"
                        : "hover:bg-primary/15 hover:text-primary cursor-pointer",
                    )}
                    title="Search in chat (Ctrl+F)"
                  >
                    <Search className="h-3 w-3" />
                  </button>
                </>
              )}

              {/* Copy chat button */}
              {activeSessionKey && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <button
                    onClick={handleCopyChat}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0 hover:bg-primary/15 hover:text-primary cursor-pointer"
                    title="Copy session details to clipboard"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </>
              )}

              {/* Compact button */}
              {tokenUsed > 0 && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <button
                    onClick={handleCompact}
                    disabled={isCompacting}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0",
                      isCompacting
                        ? "opacity-50 cursor-wait"
                        : "hover:bg-primary/15 hover:text-primary cursor-pointer",
                    )}
                    title="Summarize session — LLM compacts old messages, preserving context"
                  >
                    <Minimize2 className={cn("h-3 w-3", isCompacting && "animate-spin")} />
                    <span className="hidden sm:inline">Compact</span>
                  </button>
                </>
              )}

              {/* Archive button */}
              {activeSessionKey && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <button
                    onClick={handleArchive}
                    disabled={isArchiving}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0",
                      isArchiving
                        ? "opacity-50 cursor-wait"
                        : "hover:bg-primary/15 hover:text-primary cursor-pointer",
                    )}
                    title="Archive session — hides from active list, keeps transcript for memory search"
                  >
                    <Archive className="h-3 w-3" />
                    <span className="hidden sm:inline">Archive</span>
                  </button>
                </>
              )}
            </div>
          </div>,
          headerPortal,
        )}
    </>
  );
}
