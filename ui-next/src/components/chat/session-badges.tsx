import { Bot, Check, ChevronDown, Brain, Image, Zap, FolderOpen, Send, X } from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { type ModelEntry } from "@/components/ui/custom/status/model-selector";
import { useToast } from "@/components/ui/custom/toast";
import { Separator } from "@/components/ui/separator";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useChatStore, type SessionEntry } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";

// ─── Helpers (duplicated from chat-header; keep in sync or share via utils) ───

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

// ─── SessionBadges ───

export type SessionBadgesProps = {
  models: ModelEntry[];
  agentEmoji?: string;
  agentName?: string;
  agentRole?: string;
  agentDepartment?: string;
};

/**
 * Interactive badge row showing the active agent, project, model, and channel.
 * Renders inline (not via portal) — intended for placement near the chat input.
 */
export function SessionBadges({
  models,
  agentEmoji,
  agentName,
  agentRole,
  agentDepartment,
}: SessionBadgesProps) {
  const { sendRpc } = useGateway();
  const { toast } = useToast();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const pendingModelId = useChatStore((s) => s.pendingModelId);

  // ── Model selector ──
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const modelSelectorRef = useRef<HTMLButtonElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // ── Project selector ──
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const projectSelectorRef = useRef<HTMLButtonElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const [projectList, setProjectList] = useState<
    Array<{ id: string; name?: string; path?: string; status?: string; type?: string }>
  >([]);

  // ── Channel selector ──
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

  // pendingModelId may be provider-prefixed (e.g. "zai/glm-5-turbo") while ModelEntry.id is bare
  const pendingModel = useMemo(() => {
    if (!pendingModelId) {
      return models[0] ?? null;
    }
    return (
      models.find((m) => m.id === pendingModelId) ??
      models.find((m) => `${m.provider}/${m.id}` === pendingModelId) ??
      models[0] ??
      null
    );
  }, [models, pendingModelId]);

  const displayModel = activeModel ?? pendingModel ?? null;
  const sessionKind = (activeSession?.kind as string | undefined) ?? null;
  const sessionChannel = (activeSession?.channel as string | undefined) ?? null;

  // ── Project context ──
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

  // ── Bound channel from session deliveryContext ──
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
          const direct = (chConfig.direct ?? {}) as Record<string, unknown>;
          const groups = (chConfig.groups ?? {}) as Record<string, unknown>;
          const directIds = Object.keys(direct);
          const groupIds = Object.keys(groups);

          for (const userId of directIds) {
            targets.push({
              channel: chId,
              label,
              to: `${chId}:${userId}`,
              targetLabel: `DM (${userId})`,
              connected: true,
            });
          }
          const allowFrom = Array.isArray(chConfig.allowFrom)
            ? (chConfig.allowFrom as Array<string | number>)
            : [];
          for (const entry of allowFrom) {
            const id = String(entry).trim();
            if (!id || id === "*" || directIds.includes(id)) {
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

        // Discover DM contacts from session history
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
          const fullTo = to.startsWith(`${ch}:`) ? to : `${ch}:${to}`;
          if (knownToSet.has(fullTo)) {
            continue;
          }
          knownToSet.add(fullTo);
          const rawId = to.replace(new RegExp(`^${ch}:`), "");
          const channelsCfgEntry = (channelsCfg[ch] ?? {}) as Record<string, unknown>;
          const cfgGroups = (channelsCfgEntry.groups ?? {}) as Record<string, unknown>;
          const isGroup = rawId.startsWith("-") || rawId in cfgGroups;
          if (isGroup) {
            continue;
          }
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

  // ── Model switch ──
  const handleModelSwitch = useCallback(
    async (modelId: string, provider?: string) => {
      setModelSelectorOpen(false);
      const modelRef = provider ? `${provider}/${modelId}` : modelId;
      const activeSessionNow = useChatStore
        .getState()
        .sessions.find((s) => s.key === useChatStore.getState().activeSessionKey);
      if (!activeSessionNow) {
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
      if (
        !modelSelectorRef.current?.contains(target) &&
        !modelDropdownRef.current?.contains(target)
      ) {
        setModelSelectorOpen(false);
      }
    };
    const id = setTimeout(() => window.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [modelSelectorOpen]);

  return (
    <>
      {/* Badge row */}
      <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono text-muted-foreground min-w-0">
        {/* Agent identity chip */}
        {agentEmoji && agentName && (
          <>
            <span className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md bg-primary/5 border border-primary/10 text-primary/70">
              <span>{agentEmoji}</span>
              <span className="font-medium">{agentName}</span>
            </span>
            <Separator orientation="vertical" className="h-3" />
          </>
        )}

        {/* Agent department / role chips */}
        {agentDepartment && (
          <span className="hidden md:flex items-center shrink-0 px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40 text-muted-foreground/70">
            {agentDepartment}
          </span>
        )}
        {agentRole && (
          <span className="hidden md:flex items-center shrink-0 px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40 text-muted-foreground/70">
            {agentRole}
          </span>
        )}

        {/* Session kind / channel chip */}
        {(sessionKind || sessionChannel) && (
          <>
            <span className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40">
              {sessionChannel ? (
                <>
                  <Zap className="h-2.5 w-2.5" />
                  {sessionChannel}
                </>
              ) : (
                sessionKind
              )}
            </span>
            <Separator orientation="vertical" className="h-3" />
          </>
        )}

        {/* Project chip */}
        <button
          ref={projectSelectorRef}
          onClick={() => setProjectSelectorOpen((prev) => !prev)}
          className={cn(
            "flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md transition-colors cursor-pointer",
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

        {/* Model chip */}
        {displayModel && (
          <>
            <Separator orientation="vertical" className="h-3" />
            <button
              ref={modelSelectorRef}
              onClick={() => setModelSelectorOpen((prev) => !prev)}
              className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md bg-primary/5 border border-primary/10 text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
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
        <>
          <Separator orientation="vertical" className="h-3" />
          <button
            ref={channelSelectorRef}
            onClick={() => setChannelSelectorOpen((prev) => !prev)}
            className={cn(
              "flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-md transition-colors cursor-pointer",
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
        </>
      </div>

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
              // Open upward since we're near the bottom of the viewport
              return { bottom: window.innerHeight - rect.top + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom">
              <div className="max-h-80 overflow-y-auto">
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
              return { bottom: window.innerHeight - rect.top + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom">
              <div className="max-h-80 overflow-y-auto">
                {models.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No models available
                  </div>
                ) : (
                  Object.entries(groupModelsByProvider(models)).map(
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
              return { bottom: window.innerHeight - rect.top + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom">
              <div className="max-h-80 overflow-y-auto">
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
