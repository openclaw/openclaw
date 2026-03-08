import { Bot, Check, ChevronDown, Brain, Image, Zap, Minimize2, Archive, Maximize2 } from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { formatSessionTitle } from "@/components/chat/chat-sidebar";
import { type ModelEntry } from "@/components/ui/custom/status/model-selector";
import { useToast } from "@/components/ui/custom/toast";
import { Separator } from "@/components/ui/separator";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useChatStore, type SessionEntry } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";
import type { AgentRow } from "@/types/agents";

// ─── Helpers ───

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

function formatContextWindow(tokens?: number): string {
  if (!tokens) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}k`;
  }
  return String(tokens);
}

function providerColor(provider: string): string {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return "text-chart-5";
    case "openai":
      return "text-chart-2";
    case "google":
      return "text-chart-1";
    default:
      return "text-muted-foreground";
  }
}

function groupModelsByProvider(models: ModelEntry[]): Record<string, ModelEntry[]> {
  const groups: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    const key = m.provider || "other";
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(m);
  }
  return groups;
}

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

// ─── ChatHeader ───

export type ChatHeaderProps = {
  models: ModelEntry[];
  loadSessions: () => Promise<void>;
  loadHistory: () => Promise<void>;
  switchSession: (key: string) => void;
  agentEmoji?: string;
  agentName?: string;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
};

export function ChatHeader({ models, loadSessions, loadHistory, switchSession, agentEmoji, agentName, focusMode = false, onToggleFocusMode }: ChatHeaderProps) {
  const { sendRpc } = useGateway();
  const { toast } = useToast();
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const modelSelectorRef = useRef<HTMLButtonElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.key === activeSessionKey),
    [sessions, activeSessionKey],
  );

  const activeModel = useMemo(
    () => models.find((m) => m.id === activeSession?.model),
    [models, activeSession?.model],
  );
  const displayModel = activeModel ?? null;

  const activeProvider =
    (activeSession?.modelProvider as string | undefined) ?? displayModel?.provider;
  const filteredModels = useMemo(
    () => (activeProvider ? models.filter((m) => m.provider === activeProvider) : models),
    [models, activeProvider],
  );

  // Context window usage
  const inputTokens =
    (activeSession?.inputTokens as number | undefined) ??
    activeSession?.tokenCounts?.totalInput ??
    0;
  const outputTokens =
    (activeSession?.outputTokens as number | undefined) ??
    activeSession?.tokenCounts?.totalOutput ??
    0;
  const tokenUsed = inputTokens + outputTokens;
  const contextTotal =
    (activeSession?.contextTokens as number | undefined) ?? displayModel?.contextWindow ?? 0;

  const sessionTitle = activeSession ? formatSessionTitle(activeSession) : "New Chat";
  const sessionKind = (activeSession?.kind as string | undefined) ?? null;
  const sessionChannel = (activeSession?.channel as string | undefined) ?? null;

  // Switch model
  const handleModelSwitch = useCallback(
    async (modelId: string, provider?: string) => {
      setModelSelectorOpen(false);
      const modelRef = provider ? `${provider}/${modelId}` : modelId;
      try {
        await sendRpc("sessions.patch", { key: activeSessionKey, model: modelRef });
        const result = await sendRpc<{ sessions: { key: string; model?: string }[] }>(
          "sessions.list",
          { limit: 50, includeDerivedTitles: true, includeLastMessage: true },
        );
        useChatStore.getState().setSessions((result?.sessions as SessionEntry[]) ?? []);
        toast("Model switched successfully", "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[chat] model switch failed:", err);
        toast(`Failed to switch model: ${msg}`, "error");
      }
    },
    [sendRpc, activeSessionKey, toast],
  );

  // Close model selector on Escape
  useEffect(() => {
    if (!modelSelectorOpen) {
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModelSelectorOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modelSelectorOpen]);

  // Close model selector on click outside
  useEffect(() => {
    if (!modelSelectorOpen) {
      return;
    }
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = modelSelectorRef.current?.contains(target);
      const inDropdown = modelDropdownRef.current?.contains(target);
      if (!inTrigger && !inDropdown) {
        setModelSelectorOpen(false);
      }
    };
    const id = setTimeout(() => window.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [modelSelectorOpen]);

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
      }>("sessions.compactSmart", { key: sessionKey });
      if (res?.compacted) {
        const saved =
          res.tokensBefore && res.tokensAfter
            ? ` (${Math.round(((res.tokensBefore - res.tokensAfter) / res.tokensBefore) * 100)}% tokens freed)`
            : "";
        toast(`Session summarized${saved}`, "success");
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

  // Shell header portal target
  const headerPortal =
    typeof document !== "undefined" ? document.getElementById("shell-header-extra") : null;

  return (
    <>
      {/* Session details injected into Shell header via portal */}
      {headerPortal &&
        createPortal(
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground min-w-0">
            {/* Session title — always visible */}
            <span
              className="truncate max-w-[180px] sm:max-w-[260px] text-foreground/80 font-medium"
              title={sessionTitle}
            >
              {sessionTitle}
            </span>

            {/* Focus mode toggle */}
            {onToggleFocusMode && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <button
                  onClick={onToggleFocusMode}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0 cursor-pointer",
                    focusMode
                      ? "bg-primary/15 text-primary"
                      : "hover:bg-primary/15 hover:text-primary",
                  )}
                  title={focusMode ? "Exit focus mode (Cmd+Shift+F)" : "Focus mode (Cmd+Shift+F)"}
                  aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
                >
                  <Maximize2 className="h-3 w-3" />
                  <span className="hidden sm:inline">{focusMode ? "Focused" : "Focus"}</span>
                </button>
              </>
            )}

            {/* Elements hidden in focus mode */}
            <div className={cn(
              "flex items-center gap-2 transition-all duration-200",
              focusMode ? "opacity-0 w-0 overflow-hidden pointer-events-none" : "opacity-100",
            )}>
              {/* Agent identity chip */}
              {agentEmoji && agentName && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <span className="flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/5 border border-primary/10 text-primary/70">
                    <span>{agentEmoji}</span>
                    <span className="font-medium">{agentName}</span>
                  </span>
                </>
              )}

              {/* Session kind / channel chip */}
              {(sessionKind || sessionChannel) && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <span className="flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40">
                    {sessionChannel ? (
                      <>
                        <Zap className="h-2.5 w-2.5" />
                        {sessionChannel}
                      </>
                    ) : (
                      sessionKind
                    )}
                  </span>
                </>
              )}

              {/* Model chip */}
              {activeSession?.model && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <button
                    ref={modelSelectorRef}
                    onClick={() => setModelSelectorOpen((prev) => !prev)}
                    className="hidden sm:flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/5 border border-primary/10 text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
                  >
                    <Bot className="h-2.5 w-2.5" />
                    <span className="truncate max-w-[120px]">
                      {displayModel?.name ?? activeSession.model.split("/").pop()}
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-2 w-2 shrink-0 opacity-50 transition-transform",
                        modelSelectorOpen && "rotate-180",
                      )}
                    />
                  </button>
                </>
              )}

              {/* Token usage */}
              {(inputTokens > 0 || outputTokens > 0) && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <span
                    className="shrink-0 tabular-nums"
                    title={`Input: ${inputTokens.toLocaleString()} / Output: ${outputTokens.toLocaleString()}`}
                  >
                    {formatTokenCount(inputTokens + outputTokens)}
                    {contextTotal > 0 && (
                      <span className="text-muted-foreground/50">
                        {" / "}
                        {formatContextWindow(contextTotal)}
                      </span>
                    )}
                  </span>
                  {/* Mini context bar */}
                  {contextTotal > 0 && tokenUsed > 0 && (
                    <div className="hidden sm:block w-16 h-1.5 rounded-full bg-secondary/60 overflow-hidden shrink-0">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          tokenUsed / contextTotal > 0.95
                            ? "bg-destructive"
                            : tokenUsed / contextTotal > 0.8
                              ? "bg-chart-5"
                              : "bg-primary/60",
                        )}
                        style={{ width: `${Math.min((tokenUsed / contextTotal) * 100, 100)}%` }}
                      />
                    </div>
                  )}
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

      {/* Model selector dropdown — portalled to body */}
      {modelSelectorOpen &&
        createPortal(
          <div
            ref={modelDropdownRef}
            className="fixed z-[9999]"
            style={(() => {
              const rect = modelSelectorRef.current?.getBoundingClientRect();
              if (!rect) {
                return { top: 0, left: 0 };
              }
              return { top: rect.bottom + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top">
              <div className="max-h-80 overflow-y-auto">
                {filteredModels.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No models available
                  </div>
                ) : (
                  Object.entries(groupModelsByProvider(filteredModels)).map(
                    ([provider, providerModels]) => (
                      <div key={provider}>
                        <div className="sticky top-0 bg-popover px-3 py-1.5 border-b border-border/50">
                          <span
                            className={cn(
                              "text-[10px] font-mono uppercase tracking-wider",
                              providerColor(provider),
                            )}
                          >
                            {provider}
                          </span>
                        </div>
                        {providerModels.map((model) => {
                          const isSelected = model.id === activeSession?.model;
                          const isAllowed = model.allowed !== false;
                          return (
                            <button
                              key={model.id}
                              onClick={() => handleModelSwitch(model.id, model.provider)}
                              className={cn(
                                "flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/40 transition-colors",
                                isSelected && "bg-primary/5",
                                !isAllowed && "opacity-50",
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-mono truncate">{model.name}</span>
                                  {model.reasoning && (
                                    <span title="Reasoning">
                                      <Brain className="h-3 w-3 text-chart-5 shrink-0" />
                                    </span>
                                  )}
                                  {model.input?.includes("image") && (
                                    <span title="Vision">
                                      <Image className="h-3 w-3 text-chart-2 shrink-0" />
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[10px] font-mono text-muted-foreground truncate">
                                    {model.id}
                                  </span>
                                  {model.contextWindow && (
                                    <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                                      {formatContextWindow(model.contextWindow)} ctx
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isSelected && (
                                <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ),
                  )
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
