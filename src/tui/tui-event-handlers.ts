import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

const RECENT_FINALIZED_RUN_WINDOW_MS = 30_000;

type EventHandlerChatLog = {
  startTool: (toolCallId: string, toolName: string, args: unknown) => void;
  updateToolResult: (
    toolCallId: string,
    result: unknown,
    options?: { partial?: boolean; isError?: boolean },
  ) => void;
  addSystem: (text: string) => void;
  updateAssistant: (text: string, runId: string) => void;
  finalizeAssistant: (text: string, runId: string) => void;
  dropAssistant: (runId: string) => void;
};

type EventHandlerTui = {
  requestRender: () => void;
};

type EventHandlerContext = {
  chatLog: EventHandlerChatLog;
  tui: EventHandlerTui;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory?: () => Promise<void>;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
};

export function createEventHandlers(context: EventHandlerContext) {
  const {
    chatLog,
    tui,
    state,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
  } = context;
  const finalizedRuns = new Map<string, number>();
  const sessionRuns = new Map<string, number>();
  const startedRuns = new Set<string>();
  const pendingChatEventsByRun = new Map<string, ChatEvent[]>();
  const pendingToolEventsByRun = new Map<string, AgentEvent[]>();
  let streamAssembler = new TuiStreamAssembler();
  let lastSessionKey = state.currentSessionKey;
  const formatServedLabel = () => {
    const model = state.sessionInfo.servedModel?.trim();
    if (!model) {
      return null;
    }
    const provider = state.sessionInfo.servedModelProvider?.trim();
    if (!provider) {
      return model;
    }
    if (model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
      return model;
    }
    return `${provider}/${model}`;
  };

  const pruneRunMap = (runs: Map<string, number>) => {
    if (runs.size <= 200) {
      return;
    }
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of runs) {
      if (runs.size <= 150) {
        break;
      }
      if (ts < keepUntil) {
        runs.delete(key);
      }
    }
    if (runs.size > 200) {
      for (const key of runs.keys()) {
        runs.delete(key);
        if (runs.size <= 150) {
          break;
        }
      }
    }
  };

  const syncSessionKey = () => {
    if (state.currentSessionKey === lastSessionKey) {
      return;
    }
    lastSessionKey = state.currentSessionKey;
    finalizedRuns.clear();
    sessionRuns.clear();
    startedRuns.clear();
    pendingChatEventsByRun.clear();
    pendingToolEventsByRun.clear();
    streamAssembler = new TuiStreamAssembler();
    clearLocalRunIds?.();
  };

  const noteSessionRun = (runId: string) => {
    sessionRuns.set(runId, Date.now());
    pruneRunMap(sessionRuns);
  };

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    sessionRuns.delete(runId);
    startedRuns.delete(runId);
    pendingChatEventsByRun.delete(runId);
    pendingToolEventsByRun.delete(runId);
    streamAssembler.drop(runId);
    state.sessionInfo.servedModel = undefined;
    state.sessionInfo.servedModelProvider = undefined;
    pruneRunMap(finalizedRuns);
  };

  const clearActiveRunIfMatch = (runId: string) => {
    if (state.activeChatRunId === runId) {
      state.activeChatRunId = null;
    }
  };

  const finalizeRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "idle" | "error";
  }) => {
    noteFinalizedRun(params.runId);
    clearActiveRunIfMatch(params.runId);
    if (params.wasActiveRun) {
      setActivityStatus(params.status);
    }
    void refreshSessionInfo?.();
  };

  const terminateRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "aborted" | "error";
  }) => {
    streamAssembler.drop(params.runId);
    sessionRuns.delete(params.runId);
    clearActiveRunIfMatch(params.runId);
    if (params.wasActiveRun) {
      setActivityStatus(params.status);
    }
    void refreshSessionInfo?.();
  };

  const hasConcurrentActiveRun = (runId: string) => {
    const activeRunId = state.activeChatRunId;
    if (!activeRunId || activeRunId === runId) {
      return false;
    }
    return sessionRuns.has(activeRunId);
  };

  const maybeRefreshHistoryForRun = (runId: string) => {
    if (isLocalRunId?.(runId)) {
      forgetLocalRunId?.(runId);
      return;
    }
    if (hasConcurrentActiveRun(runId)) {
      return;
    }
    void loadHistory?.();
  };

  const enqueuePendingChatEvent = (evt: ChatEvent) => {
    const queue = pendingChatEventsByRun.get(evt.runId) ?? [];
    queue.push(evt);
    pendingChatEventsByRun.set(evt.runId, queue);
  };

  const enqueuePendingToolEvent = (evt: AgentEvent) => {
    const queue = pendingToolEventsByRun.get(evt.runId) ?? [];
    queue.push(evt);
    pendingToolEventsByRun.set(evt.runId, queue);
  };

  const processChatEvent = (evt: ChatEvent) => {
    if (evt.state === "delta") {
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) {
        return;
      }
      chatLog.updateAssistant(displayText, evt.runId);
      setActivityStatus("streaming");
    }
    if (evt.state === "final") {
      const wasActiveRun = state.activeChatRunId === evt.runId;
      if (!evt.message) {
        maybeRefreshHistoryForRun(evt.runId);
        chatLog.dropAssistant(evt.runId);
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle" });
        return;
      }
      if (isCommandMessage(evt.message)) {
        maybeRefreshHistoryForRun(evt.runId);
        const text = extractTextFromMessage(evt.message);
        if (text) {
          chatLog.addSystem(text);
        }
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle" });
        return;
      }
      maybeRefreshHistoryForRun(evt.runId);
      const msgRecord =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? (evt.message as Record<string, unknown>)
          : undefined;
      const stopReason =
        msgRecord && typeof msgRecord.stopReason === "string" ? msgRecord.stopReason : "";
      const usageRaw = evt.usage ?? msgRecord?.usage;
      if (
        usageRaw &&
        typeof usageRaw === "object" &&
        (typeof (usageRaw as Record<string, unknown>).input === "number" ||
          typeof (usageRaw as Record<string, unknown>).output === "number")
      ) {
        const u = usageRaw as Record<string, unknown>;
        state.sessionInfo.generationPassTokens = {
          input: typeof u.input === "number" ? u.input : undefined,
          output: typeof u.output === "number" ? u.output : undefined,
        };
      }

      const finalText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking);
      const suppressEmptyExternalPlaceholder =
        finalText === "(no output)" && !isLocalRunId?.(evt.runId);
      if (suppressEmptyExternalPlaceholder) {
        chatLog.dropAssistant(evt.runId);
      } else {
        chatLog.finalizeAssistant(finalText, evt.runId);
      }
      finalizeRun({
        runId: evt.runId,
        wasActiveRun,
        status: stopReason === "error" ? "error" : "idle",
      });
    }
    if (evt.state === "aborted") {
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem("run aborted");
      terminateRun({ runId: evt.runId, wasActiveRun, status: "aborted" });
      maybeRefreshHistoryForRun(evt.runId);
    }
    if (evt.state === "error") {
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      terminateRun({ runId: evt.runId, wasActiveRun, status: "error" });
      maybeRefreshHistoryForRun(evt.runId);
    }
  };

  const processToolEvent = (evt: AgentEvent) => {
    const verbose = state.sessionInfo.verboseLevel ?? "off";
    const allowToolEvents = verbose !== "off";
    const allowToolOutput = verbose === "full";
    if (!allowToolEvents) {
      return false;
    }
    const data = evt.data ?? {};
    const phase = asString(data.phase, "");
    const toolCallId = asString(data.toolCallId, "");
    const toolName = asString(data.name, "tool");
    if (!toolCallId) {
      return false;
    }
    if (phase === "start") {
      chatLog.startTool(toolCallId, toolName, data.args);
    } else if (phase === "update") {
      if (!allowToolOutput) {
        return false;
      }
      chatLog.updateToolResult(toolCallId, data.partialResult, {
        partial: true,
      });
    } else if (phase === "result") {
      if (allowToolOutput) {
        chatLog.updateToolResult(toolCallId, data.result, {
          isError: Boolean(data.isError),
        });
      } else {
        chatLog.updateToolResult(toolCallId, { content: [] }, { isError: Boolean(data.isError) });
      }
    }
    return true;
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (evt.sessionKey !== state.currentSessionKey) {
      return;
    }
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") {
        return;
      }
      if (evt.state === "final") {
        return;
      }
    }
    noteSessionRun(evt.runId);
    if (!state.activeChatRunId) {
      state.activeChatRunId = evt.runId;
    }
    if (!startedRuns.has(evt.runId) && evt.state === "delta") {
      enqueuePendingChatEvent(evt);
      tui.requestRender();
      return;
    }
    processChatEvent(evt);
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as AgentEvent;
    syncSessionKey();
    const eventSessionKey =
      evt.data && typeof evt.data.sessionKey === "string" ? evt.data.sessionKey : undefined;
    const isCurrentSessionEvent =
      typeof eventSessionKey === "string" && eventSessionKey === state.currentSessionKey;
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : "";
    const isLifecycleStart = lifecyclePhase === "start";
    const isLifecycleRouter = lifecyclePhase === "router";
    if (
      (isLifecycleStart || isLifecycleRouter) &&
      !state.activeChatRunId &&
      isCurrentSessionEvent
    ) {
      state.activeChatRunId = evt.runId;
      noteSessionRun(evt.runId);
    }
    // Agent events (tool streaming, lifecycle) are emitted per-run. Filter against the
    // active chat run id, not the session id. Tool results can arrive after the chat
    // final event, so accept finalized runs for tool updates.
    const isActiveRun = evt.runId === state.activeChatRunId;
    const isKnownRun = isActiveRun || sessionRuns.has(evt.runId) || finalizedRuns.has(evt.runId);
    if (!isKnownRun) {
      return;
    }
    if (evt.stream === "tool") {
      const recentlyFinalizedAt = finalizedRuns.get(evt.runId);
      const isRecentlyFinalizedRun =
        typeof recentlyFinalizedAt === "number" &&
        Date.now() - recentlyFinalizedAt <= RECENT_FINALIZED_RUN_WINDOW_MS;
      if (isRecentlyFinalizedRun && !startedRuns.has(evt.runId)) {
        startedRuns.add(evt.runId);
      }
      if (!startedRuns.has(evt.runId)) {
        enqueuePendingToolEvent(evt);
        tui.requestRender();
        return;
      }
      const changed = processToolEvent(evt);
      if (changed) {
        tui.requestRender();
      }
      return;
    }
    if (evt.stream === "lifecycle") {
      if (!isActiveRun && !isLifecycleStart && !isLifecycleRouter) {
        return;
      }
      const phase = lifecyclePhase;
      const applyServedModel = (providerRaw: unknown, modelRaw: unknown) => {
        const provider = typeof providerRaw === "string" ? providerRaw.trim() : "";
        const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
        if (!model) {
          return;
        }
        state.sessionInfo.servedModel = model;
        state.sessionInfo.servedModelProvider = provider || undefined;
      };
      // Prefer explicit runtime model fields, then router/fallback payloads.
      applyServedModel(evt.data?.servedProvider, evt.data?.servedModel);
      applyServedModel(evt.data?.activeProvider, evt.data?.activeModel);
      const routerData =
        evt.data && typeof evt.data.router === "object" && evt.data.router
          ? (evt.data.router as Record<string, unknown>)
          : undefined;
      applyServedModel(routerData?.provider, routerData?.model);

      const generating =
        evt.data && typeof evt.data.generating === "object" && evt.data.generating
          ? (evt.data.generating as Record<string, unknown>)
          : undefined;
      const eventThink =
        (typeof evt.data?.effectiveThink === "string" ? evt.data.effectiveThink : undefined) ??
        (generating && typeof generating.thinkingLevel === "string"
          ? generating.thinkingLevel
          : undefined);
      const configuredThinkFromEvent =
        typeof evt.data?.configuredThink === "string" ? evt.data.configuredThink : undefined;
      if (eventThink) {
        state.sessionInfo.effectiveThink = eventThink;
        state.sessionInfo.lastEffectiveThink = eventThink;
      }
      if (configuredThinkFromEvent) {
        state.sessionInfo.configuredThink = configuredThinkFromEvent;
      }
      const routingPass =
        generating && typeof generating.routingPass === "object" && generating.routingPass
          ? (generating.routingPass as Record<string, unknown>)
          : undefined;
      const pass1 = routingPass?.pass1TokenUsage as { input?: number; output?: number } | undefined;
      const pass2 = routingPass?.pass2TokenUsage as { input?: number; output?: number } | undefined;
      if (phase === "start") {
        state.sessionInfo.currentRunId = evt.runId;
        state.sessionInfo.generationPassTokens = null;
        if (!state.sessionInfo.routerPassTokens) {
          state.sessionInfo.routerPassTokens = null;
        }
        startedRuns.add(evt.runId);
      }
      if (pass1 && (typeof pass1.input === "number" || typeof pass1.output === "number")) {
        state.sessionInfo.routerPassTokens = {
          input: pass1.input,
          output: pass1.output,
        };
      }
      if (pass2 && (typeof pass2.input === "number" || typeof pass2.output === "number")) {
        state.sessionInfo.generationPassTokens = {
          input: pass2.input,
          output: pass2.output,
        };
      }
      if (phase === "router") {
        state.sessionInfo.currentRunId = evt.runId;
        state.sessionInfo.generationPassTokens = null;
        startedRuns.add(evt.runId);
        const configuredThink =
          state.sessionInfo.configuredThink ?? state.sessionInfo.thinkingLevel ?? "auto";
        const resolvedThink =
          state.sessionInfo.effectiveThink ??
          state.sessionInfo.lastEffectiveThink ??
          state.sessionInfo.thinkingLevel;
        const routingStatus =
          configuredThink === "auto"
            ? resolvedThink
              ? `routing (think auto→${resolvedThink})`
              : "routing (think auto)"
            : "routing";
        const servedLabel = formatServedLabel();
        setActivityStatus(servedLabel ? `${routingStatus} · model ${servedLabel}` : routingStatus);
      }
      if (phase === "start") {
        const pendingChat = pendingChatEventsByRun.get(evt.runId) ?? [];
        pendingChatEventsByRun.delete(evt.runId);
        const pendingTools = pendingToolEventsByRun.get(evt.runId) ?? [];
        pendingToolEventsByRun.delete(evt.runId);
        const configuredThink =
          state.sessionInfo.configuredThink ?? state.sessionInfo.thinkingLevel ?? "auto";
        const resolvedThink =
          state.sessionInfo.effectiveThink ??
          state.sessionInfo.lastEffectiveThink ??
          state.sessionInfo.thinkingLevel;
        const runningLabel =
          configuredThink === "auto"
            ? resolvedThink
              ? `running (think auto→${resolvedThink})`
              : "running (think auto)"
            : `running (think ${configuredThink})`;
        const servedLabel = formatServedLabel();
        setActivityStatus(servedLabel ? `${runningLabel} · model ${servedLabel}` : runningLabel);
        for (const pendingEvent of pendingTools) {
          processToolEvent(pendingEvent);
        }
        for (const pendingEvent of pendingChat) {
          processChatEvent(pendingEvent);
        }
      }
      if (phase === "end") {
        if (eventThink) {
          state.sessionInfo.lastEffectiveThink = eventThink;
        }
        state.sessionInfo.lastRunId = evt.runId;
        if (state.sessionInfo.currentRunId === evt.runId) {
          state.sessionInfo.currentRunId = undefined;
        }
        state.sessionInfo.routerPassTokens = null;
        state.sessionInfo.generationPassTokens = null;
        state.sessionInfo.servedModel = undefined;
        state.sessionInfo.servedModelProvider = undefined;
        setActivityStatus("idle");
      }
      if (phase === "error") {
        state.sessionInfo.lastRunId = evt.runId;
        if (state.sessionInfo.currentRunId === evt.runId) {
          state.sessionInfo.currentRunId = undefined;
        }
        state.sessionInfo.routerPassTokens = null;
        state.sessionInfo.generationPassTokens = null;
        state.sessionInfo.servedModel = undefined;
        state.sessionInfo.servedModelProvider = undefined;
        setActivityStatus("error");
      }
      tui.requestRender();
    }
  };

  return { handleChatEvent, handleAgentEvent };
}
