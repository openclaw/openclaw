import {
  Bot,
  Check,
  ChevronDown,
  Brain,
  Image,
  Zap,
  Minimize2,
  Archive,
  Pencil,
  FolderOpen,
  Send,
  Search,
  Copy,
  X,
} from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { formatSessionTitle } from "@/components/chat/chat-sidebar";
import { type ModelEntry } from "@/components/ui/custom/status/model-selector";
import { useToast } from "@/components/ui/custom/toast";
import { Separator } from "@/components/ui/separator";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useChatStore, getMessageText, type SessionEntry } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";
import type { AgentRow } from "@/types/agents";

// ─── Helpers ───

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
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const pendingModelId = useChatStore((s) => s.pendingModelId);

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const modelSelectorRef = useRef<HTMLButtonElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Project selector
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const projectSelectorRef = useRef<HTMLButtonElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const [projectList, setProjectList] = useState<
    Array<{ id: string; name?: string; path?: string; status?: string; type?: string }>
  >([]);

  // Channel selector
  const [channelSelectorOpen, setChannelSelectorOpen] = useState(false);
  const channelSelectorRef = useRef<HTMLButtonElement>(null);
  const channelDropdownRef = useRef<HTMLDivElement>(null);
  type ChannelTarget = {
    channel: string;
    label: string;
    to?: string;
    targetLabel?: string;
    connected?: boolean;
  };
  const [channelTargets, setChannelTargets] = useState<ChannelTarget[]>([]);
  const [boundChannel, setBoundChannel] = useState<{
    channel: string;
    to?: string;
    label: string;
  } | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.key === activeSessionKey),
    [sessions, activeSessionKey],
  );

  const activeModel = useMemo(
    () => models.find((m) => m.id === activeSession?.model),
    [models, activeSession?.model],
  );
  // When there's no active session, show the pending model selection (or the first available model).
  const pendingModel = useMemo(
    () => models.find((m) => m.id === pendingModelId) ?? models[0] ?? null,
    [models, pendingModelId],
  );
  const displayModel = activeModel ?? pendingModel ?? null;

  const filteredModels = models;

  // Context window usage — prefer totalTokens (prompt tokens from last API call = actual context usage)
  const tokenUsed =
    (activeSession?.totalTokens as number | undefined) ??
    ((activeSession?.inputTokens as number | undefined) ??
      activeSession?.tokenCounts?.totalInput ??
      0) +
      ((activeSession?.outputTokens as number | undefined) ??
        activeSession?.tokenCounts?.totalOutput ??
        0);
  const sessionTitle = activeSession ? formatSessionTitle(activeSession) : "New Chat";
  const sessionKind = (activeSession?.kind as string | undefined) ?? null;
  const sessionChannel = (activeSession?.channel as string | undefined) ?? null;

  // Project context for active session
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (!isConnected || !activeSessionKey) {
      setProjectName(null);
      return;
    }
    sendRpc<{ id?: string; name?: string } | null>("projects.getContext", {
      sessionKey: activeSessionKey,
    })
      .then((result) => setProjectName(result?.name ?? null))
      .catch(() => setProjectName(null));
  }, [isConnected, activeSessionKey, sendRpc]);

  // Fetch project list when selector opens
  useEffect(() => {
    if (!projectSelectorOpen || !isConnected) {
      return;
    }
    sendRpc<{ projects?: Array<{ id: string; name?: string; path?: string; status?: string }> }>(
      "projects.list",
      {},
    )
      .then((res) => setProjectList(res?.projects ?? []))
      .catch(() => setProjectList([]));
  }, [projectSelectorOpen, isConnected, sendRpc]);

  // Bind session to project
  const handleBindProject = useCallback(
    async (projectId: string) => {
      setProjectSelectorOpen(false);
      const project = projectList.find((p) => p.id === projectId);
      const displayName = project?.name ?? projectId;
      try {
        await sendRpc("projects.bindSession", { sessionKey: activeSessionKey, projectId });
        setProjectName(displayName);
        useChatStore.getState().appendMessage(
          {
            role: "system",
            content: `Project bound: ${displayName}`,
            timestamp: Date.now(),
            seq: 0,
          },
          activeSessionKey,
        );
        toast(`Bound to project: ${displayName}`, "success");
      } catch (err) {
        toast(
          `Failed to bind project: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [sendRpc, activeSessionKey, toast, projectList],
  );

  // Unbind project
  const handleUnbindProject = useCallback(async () => {
    setProjectSelectorOpen(false);
    try {
      await sendRpc("projects.unbindSession", { sessionKey: activeSessionKey });
      setProjectName(null);
      useChatStore.getState().appendMessage(
        {
          role: "system",
          content: "Project unbound",
          timestamp: Date.now(),
          seq: 0,
        },
        activeSessionKey,
      );
      toast("Project unbound", "success");
    } catch {
      toast("Failed to unbind project", "error");
    }
  }, [sendRpc, activeSessionKey, toast]);

  // Close project selector on escape/outside click
  useEffect(() => {
    if (!projectSelectorOpen) {
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProjectSelectorOpen(false);
      }
    };
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !projectSelectorRef.current?.contains(target) &&
        !projectDropdownRef.current?.contains(target)
      ) {
        setProjectSelectorOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    const id = setTimeout(() => window.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [projectSelectorOpen]);

  // Load bound channel from active session's deliveryContext
  useEffect(() => {
    if (!activeSession) {
      setBoundChannel(null);
      return;
    }
    const dc = activeSession.deliveryContext as { channel?: string; to?: string } | undefined;
    const lastCh = activeSession.lastChannel as string | undefined;
    const ch = dc?.channel ?? lastCh;
    if (ch && ch !== "webchat") {
      const to = dc?.to ?? (activeSession.lastTo as string | undefined);
      setBoundChannel({ channel: ch, to, label: ch.charAt(0).toUpperCase() + ch.slice(1) });
    } else {
      setBoundChannel(null);
    }
  }, [activeSession]);

  // Fetch channel targets when selector opens
  useEffect(() => {
    if (!channelSelectorOpen || !isConnected) {
      return;
    }
    void (async () => {
      try {
        const [statusRes, cfgRes, sessionsRes] = await Promise.all([
          sendRpc<{
            channelOrder?: string[];
            channelLabels?: Record<string, string>;
            channels?: Record<string, { configured?: boolean }>;
          }>("channels.status", {}),
          sendRpc<Record<string, unknown>>("config.get", {}),
          sendRpc<{
            sessions: Array<{
              key: string;
              lastChannel?: string;
              lastTo?: string;
              label?: string;
              derivedTitle?: string;
              displayName?: string;
            }>;
          }>("sessions.list", { limit: 100 }),
        ]);
        const targets: ChannelTarget[] = [];
        const order = statusRes?.channelOrder ?? Object.keys(statusRes?.channels ?? {});
        const labels = statusRes?.channelLabels ?? {};
        // config.get returns { config: {...}, raw, hash } — unwrap first
        const fullCfg = (cfgRes?.config ?? {}) as Record<string, unknown>;
        const channelsCfg = (fullCfg.channels ?? {}) as Record<string, unknown>;

        for (const chId of order) {
          if (chId === "webchat" || chId === "web") {
            continue;
          }
          const chStatus = (statusRes?.channels ?? {})[chId] as
            | { configured?: boolean }
            | undefined;
          if (!chStatus?.configured) {
            continue;
          }
          const label = labels[chId] ?? chId.charAt(0).toUpperCase() + chId.slice(1);
          const chConfig = (channelsCfg[chId] ?? {}) as Record<string, unknown>;

          // Add DM/direct targets
          const direct = (chConfig.direct ?? {}) as Record<string, unknown>;
          const groups = (chConfig.groups ?? {}) as Record<string, unknown>;
          const directIds = Object.keys(direct);
          const groupIds = Object.keys(groups);

          // Collect DM targets from explicit `direct` config entries
          for (const userId of directIds) {
            targets.push({
              channel: chId,
              label,
              to: `${chId}:${userId}`,
              targetLabel: `DM (${userId})`,
              connected: true,
            });
          }
          // Also pull paired users from allowFrom (DMs via pairing)
          const allowFrom = Array.isArray(chConfig.allowFrom)
            ? (chConfig.allowFrom as Array<string | number>)
            : [];
          for (const entry of allowFrom) {
            const id = String(entry).trim();
            if (!id || id === "*") {
              continue;
            }
            // Skip if already listed as a direct target
            if (directIds.includes(id)) {
              continue;
            }
            targets.push({
              channel: chId,
              label,
              to: `${chId}:${id}`,
              targetLabel: `DM (${id})`,
              connected: true,
            });
          }
          for (const groupId of groupIds) {
            const groupCfg = (groups[groupId] ?? {}) as { label?: string; name?: string };
            const groupLabel = groupCfg.label ?? groupCfg.name ?? groupId;
            targets.push({
              channel: chId,
              label,
              to: `${chId}:${groupId}`,
              targetLabel: `Group: ${groupLabel}`,
              connected: true,
            });
          }
        }

        // Discover DM contacts from session history — users who've messaged the bot
        const knownToSet = new Set(targets.map((t) => t.to).filter(Boolean));
        const configuredChannels = new Set(
          order.filter((chId) => {
            const s = (statusRes?.channels ?? {})[chId] as { configured?: boolean } | undefined;
            return s?.configured && chId !== "webchat" && chId !== "web";
          }),
        );
        for (const sess of sessionsRes?.sessions ?? []) {
          const ch = sess.lastChannel?.trim();
          const to = sess.lastTo?.trim();
          if (!ch || !to || !configuredChannels.has(ch)) {
            continue;
          }
          // Skip if already added from config
          const fullTo = to.startsWith(`${ch}:`) ? to : `${ch}:${to}`;
          if (knownToSet.has(fullTo)) {
            continue;
          }
          knownToSet.add(fullTo);
          // Determine if this is a group (negative ID for Telegram, or matches a config group)
          const rawId = to.replace(new RegExp(`^${ch}:`), "");
          const channelsCfgEntry = (channelsCfg[ch] ?? {}) as Record<string, unknown>;
          const cfgGroups = (channelsCfgEntry.groups ?? {}) as Record<string, unknown>;
          const isGroup = rawId.startsWith("-") || rawId in cfgGroups;
          if (isGroup) {
            continue;
          } // groups already handled from config
          const label = labels[ch] ?? ch.charAt(0).toUpperCase() + ch.slice(1);
          const contactLabel = sess.displayName ?? sess.label ?? rawId;
          targets.push({
            channel: ch,
            label,
            to: fullTo,
            targetLabel: `DM (${contactLabel})`,
            connected: true,
          });
        }

        setChannelTargets(targets);
      } catch {
        setChannelTargets([]);
      }
    })();
  }, [channelSelectorOpen, isConnected, sendRpc]);

  // Bind channel
  const handleBindChannel = useCallback(
    async (target: ChannelTarget) => {
      setChannelSelectorOpen(false);
      try {
        const dc: Record<string, unknown> = { channel: target.channel };
        if (target.to) {
          dc.to = target.to;
        }
        await sendRpc("sessions.patch", { key: activeSessionKey, deliveryContext: dc });
        setBoundChannel({ channel: target.channel, to: target.to, label: target.label });
        toast(
          `Bound to ${target.label}${target.targetLabel ? ` — ${target.targetLabel}` : ""}`,
          "success",
        );
      } catch (err) {
        toast(
          `Failed to bind channel: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [sendRpc, activeSessionKey, toast],
  );

  // Unbind channel
  const handleUnbindChannel = useCallback(async () => {
    setChannelSelectorOpen(false);
    try {
      await sendRpc("sessions.patch", { key: activeSessionKey, deliveryContext: null });
      setBoundChannel(null);
      toast("Channel unbound — webchat only", "success");
    } catch {
      toast("Failed to unbind channel", "error");
    }
  }, [sendRpc, activeSessionKey, toast]);

  // Close channel selector on escape/outside click
  useEffect(() => {
    if (!channelSelectorOpen) {
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChannelSelectorOpen(false);
      }
    };
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !channelSelectorRef.current?.contains(target) &&
        !channelDropdownRef.current?.contains(target)
      ) {
        setChannelSelectorOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    const id = setTimeout(() => window.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [channelSelectorOpen]);

  // Switch model
  const handleModelSwitch = useCallback(
    async (modelId: string, provider?: string) => {
      setModelSelectorOpen(false);
      const modelRef = provider ? `${provider}/${modelId}` : modelId;
      // No active session yet — store as pending; will be applied after first send.
      const activeSession = useChatStore
        .getState()
        .sessions.find((s) => s.key === useChatStore.getState().activeSessionKey);
      if (!activeSession) {
        useChatStore.getState().setPendingModelId(modelRef);
        return;
      }
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

  // Copy chat transcript
  const handleCopyChat = useCallback(() => {
    const store = useChatStore.getState();
    const sessionKey = store.activeSessionKey;
    const messages = sessionKey ? store.getSessionState(sessionKey).messages : [];
    if (messages.length === 0) {
      toast("No messages to copy", "error");
      return;
    }
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.__openclaw?.kind) {
        continue;
      } // skip system dividers
      const role =
        msg.role === "user"
          ? "USER"
          : msg.role === "assistant"
            ? "ASSISTANT"
            : msg.role.toUpperCase();
      const text = getMessageText(msg);
      if (!text.trim()) {
        continue;
      }
      const ts = msg.timestamp ? new Date(msg.timestamp).toISOString().slice(0, 19) : "";
      lines.push(`[${ts}] ${role}:\n${text}\n`);
    }
    const transcript = lines.join("\n---\n\n");
    navigator.clipboard.writeText(transcript).then(
      () => toast("Chat copied to clipboard", "success"),
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

      {/* Session details injected into Shell header via portal */}
      {headerPortal &&
        createPortal(
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground min-w-0">
            <div className="flex items-center gap-2">
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

              {/* Agent department / role chips */}
              {agentDepartment && (
                <span className="hidden md:flex items-center shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40 text-muted-foreground/70">
                  {agentDepartment}
                </span>
              )}
              {agentRole && (
                <span className="hidden md:flex items-center shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40 text-muted-foreground/70">
                  {agentRole}
                </span>
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

              {/* Project chip (clickable to assign/change) */}
              <Separator orientation="vertical" className="h-3.5" />
              <button
                ref={projectSelectorRef}
                onClick={() => setProjectSelectorOpen((prev) => !prev)}
                className={cn(
                  "flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md transition-colors cursor-pointer",
                  projectName
                    ? "bg-chart-2/10 border border-chart-2/20 text-chart-2/80 hover:bg-chart-2/20"
                    : "bg-muted/50 border border-border/40 text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted",
                )}
              >
                <FolderOpen className="h-2.5 w-2.5" />
                <span className="truncate max-w-[120px]">{projectName ?? "Project"}</span>
                <ChevronDown
                  className={cn(
                    "h-2 w-2 shrink-0 opacity-50 transition-transform",
                    projectSelectorOpen && "rotate-180",
                  )}
                />
              </button>

              {/* Model chip — always visible so users can select a model before the first send */}
              {displayModel && (
                <>
                  <Separator orientation="vertical" className="h-3.5" />
                  <button
                    ref={modelSelectorRef}
                    onClick={() => setModelSelectorOpen((prev) => !prev)}
                    className="hidden sm:flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/5 border border-primary/10 text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
                  >
                    <Bot className="h-2.5 w-2.5" />
                    <span className="truncate max-w-[120px]">
                      {displayModel.name ?? displayModel.id.split("/").pop()}
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

              {/* Channel binding chip */}
              <Separator orientation="vertical" className="h-3.5" />
              <button
                ref={channelSelectorRef}
                onClick={() => setChannelSelectorOpen((prev) => !prev)}
                className={cn(
                  "hidden sm:flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md transition-colors cursor-pointer",
                  boundChannel
                    ? "bg-chart-5/10 border border-chart-5/20 text-chart-5/80 hover:bg-chart-5/20"
                    : "bg-muted/50 border border-border/40 text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted",
                )}
              >
                <Send className="h-2.5 w-2.5" />
                <span className="truncate max-w-[120px]">
                  {boundChannel ? `→ ${boundChannel.label}` : "Deliver"}
                </span>
                <ChevronDown
                  className={cn(
                    "h-2 w-2 shrink-0 opacity-50 transition-transform",
                    channelSelectorOpen && "rotate-180",
                  )}
                />
              </button>

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
                    title="Copy full chat transcript to clipboard"
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

      {/* Project selector dropdown — portalled to body */}
      {projectSelectorOpen &&
        createPortal(
          <div
            ref={projectDropdownRef}
            className="fixed z-[9999]"
            style={(() => {
              const rect = projectSelectorRef.current?.getBoundingClientRect();
              if (!rect) {
                return { top: 0, left: 0 };
              }
              return { top: rect.bottom + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top">
              <div className="max-h-80 overflow-y-auto">
                {/* Unbind option when a project is bound */}
                {projectName && (
                  <button
                    onClick={handleUnbindProject}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-destructive/10 text-destructive/70 hover:text-destructive transition-colors border-b border-border/50"
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-sm">Unbind project</span>
                  </button>
                )}
                {projectList.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No projects found
                  </div>
                ) : (
                  (() => {
                    const registered = projectList.filter((p) => p.type !== "internal");
                    const internal = projectList.filter((p) => p.type === "internal");
                    const renderItem = (project: (typeof projectList)[0]) => {
                      const isBound = projectName === project.id || projectName === project.name;
                      return (
                        <button
                          key={project.id}
                          onClick={() => handleBindProject(project.id)}
                          className={cn(
                            "flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/40 transition-colors",
                            isBound && "bg-chart-2/5",
                          )}
                        >
                          <FolderOpen
                            className={cn(
                              "h-3.5 w-3.5 shrink-0",
                              isBound ? "text-chart-2" : "text-muted-foreground",
                            )}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-mono truncate">
                              {project.name ?? project.id}
                            </div>
                            {project.path && (
                              <div className="text-[10px] font-mono text-muted-foreground truncate mt-0.5">
                                {project.path}
                              </div>
                            )}
                          </div>
                          {project.status && project.type !== "internal" && (
                            <span
                              className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
                                project.status === "active"
                                  ? "bg-chart-2/10 text-chart-2/80"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {project.status}
                            </span>
                          )}
                          {isBound && <Check className="h-3.5 w-3.5 text-chart-2 shrink-0" />}
                        </button>
                      );
                    };
                    return (
                      <>
                        {registered.length > 0 && (
                          <div>
                            <div className="sticky top-0 bg-popover px-3 py-1.5 border-b border-border/50">
                              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                                Projects
                              </span>
                            </div>
                            {registered.map(renderItem)}
                          </div>
                        )}
                        {internal.length > 0 && (
                          <div>
                            <div className="sticky top-0 bg-popover px-3 py-1.5 border-b border-border/50">
                              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                                Internal
                              </span>
                            </div>
                            {internal.map(renderItem)}
                          </div>
                        )}
                      </>
                    );
                  })()
                )}
              </div>
            </div>
          </div>,
          document.body,
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

      {/* Channel selector dropdown — portalled to body */}
      {channelSelectorOpen &&
        createPortal(
          <div
            ref={channelDropdownRef}
            className="fixed z-[9999]"
            style={(() => {
              const rect = channelSelectorRef.current?.getBoundingClientRect();
              if (!rect) {
                return { top: 0, left: 0 };
              }
              return { top: rect.bottom + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top">
              <div className="max-h-80 overflow-y-auto">
                {/* Webchat only (unbind) */}
                <button
                  onClick={boundChannel ? handleUnbindChannel : () => setChannelSelectorOpen(false)}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/40 transition-colors",
                    !boundChannel && "bg-primary/5",
                  )}
                >
                  <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm">Webchat only</span>
                  {!boundChannel && <Check className="h-3.5 w-3.5 text-primary shrink-0 ml-auto" />}
                </button>
                <div className="border-t border-border/50" />

                {channelTargets.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No configured channels found
                  </div>
                ) : (
                  (() => {
                    // Group targets by channel
                    const grouped = new Map<string, ChannelTarget[]>();
                    for (const t of channelTargets) {
                      const list = grouped.get(t.channel) ?? [];
                      list.push(t);
                      grouped.set(t.channel, list);
                    }
                    return Array.from(grouped.entries()).map(([chId, targets]) => (
                      <div key={chId}>
                        <div className="sticky top-0 bg-popover px-3 py-1.5 border-b border-border/50">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-chart-5">
                            {targets[0].label}
                          </span>
                        </div>
                        {targets.map((target, i) => {
                          const isBound =
                            boundChannel?.channel === target.channel &&
                            (target.to ? boundChannel?.to === target.to : !boundChannel?.to);
                          return (
                            <button
                              key={`${chId}-${target.to ?? i}`}
                              onClick={() => handleBindChannel(target)}
                              className={cn(
                                "flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/40 transition-colors",
                                isBound && "bg-chart-5/5",
                              )}
                            >
                              <Send
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0",
                                  isBound ? "text-chart-5" : "text-muted-foreground",
                                )}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-mono truncate">
                                  {target.targetLabel ?? "Default"}
                                </div>
                                {target.to && (
                                  <div className="text-[10px] font-mono text-muted-foreground truncate mt-0.5">
                                    {target.to}
                                  </div>
                                )}
                              </div>
                              {isBound && <Check className="h-3.5 w-3.5 text-chart-5 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    ));
                  })()
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
