import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type { AgentEvent, BtwEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

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

type EventHandlerBtwPresenter = {
  showResult: (params: { question: string; text: string; isError?: boolean }) => void;
  clear: () => void;
};

type EventHandlerContext = {
  chatLog: EventHandlerChatLog;
  btw: EventHandlerBtwPresenter;
  tui: EventHandlerTui;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory?: () => Promise<void>;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
  isLocalBtwRunId?: (runId: string) => boolean;
  forgetLocalBtwRunId?: (runId: string) => void;
  clearLocalBtwRunIds?: () => void;
};

export function createEventHandlers(context: EventHandlerContext) {
  const {
    chatLog,
    btw,
    tui,
    state,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
    isLocalBtwRunId,
    forgetLocalBtwRunId,
    clearLocalBtwRunIds,
  } = context;
  const finalizedRuns = new Map<string, number>();
  const sessionRuns = new Map<string, number>();
  let streamAssembler = new TuiStreamAssembler();
  let lastSessionKey = state.currentSessionKey;
  let pendingHistoryRefresh = false;

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
    streamAssembler = new TuiStreamAssembler();
    pendingHistoryRefresh = false;
    clearLocalRunIds?.();
    clearLocalBtwRunIds?.();
    btw.clear();
  };

  const noteSessionRun = (runId: string) => {
    sessionRuns.set(runId, Date.now());
    pruneRunMap(sessionRuns);
  };

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    sessionRuns.delete(runId);
    streamAssembler.drop(runId);
    pruneRunMap(finalizedRuns);
  };

  const clearActiveRunIfMatch = (runId: string) => {
    if (state.activeChatRunId === runId) {
      state.activeChatRunId = null;
    }
  };

  const busyActivityStatuses = new Set(["sending", "waiting", "streaming", "running"]);

  /**
   * When the gateway finalizes a run whose runId no longer matches activeChatRunId, we normally
   * avoid touching the status line so a concurrent run can keep showing streaming/running.
   * If activeChatRunId is already null and no other session runs remain in flight, the UI can be
   * stuck on "streaming" from deltas that targeted a run whose final arrived "inactive" (e.g.
   * active pointer cleared or reassigned during failover / multi-stage tool flows). Clear in
   * that orphaned case only — and only when the current status is still a busy indicator, so we
   * never overwrite a terminal status (error/aborted) set by the most recent active run.
   */
  const shouldClearOrphanedActivityStatus = (): boolean =>
    !state.activeChatRunId &&
    sessionRuns.size === 0 &&
    busyActivityStatuses.has(state.activityStatus);

  const finalizeRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "idle" | "error";
  }) => {
    noteFinalizedRun(params.runId);
    clearActiveRunIfMatch(params.runId);
    if (params.wasActiveRun) {
      setActivityStatus(params.status);
    } else if (shouldClearOrphanedActivityStatus()) {
      // Orphan path only dismisses stuck busy UI; do not surface error from a non-active run.
      setActivityStatus("idle");
    }
    void refreshSessionInfo?.();
    tryFlushPendingHistoryRefresh();
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
    } else if (shouldClearOrphanedActivityStatus()) {
      setActivityStatus("idle");
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

  /**
   * Apply a deferred history reload once it is safe: no in-flight runs remain, and any
   * activeChatRunId has at least one chat event in this handler (avoids loadHistory racing a
   * newly active run that has not emitted yet — overlapping local runs).
   */
  const tryFlushPendingHistoryRefresh = () => {
    if (!pendingHistoryRefresh || !loadHistory) {
      return;
    }
    const activeId = state.activeChatRunId;
    if (activeId && !sessionRuns.has(activeId)) {
      return;
    }
    if (sessionRuns.size > 0) {
      return;
    }
    pendingHistoryRefresh = false;
    void loadHistory();
  };

  const maybeRefreshHistoryForRun = (
    runId: string,
    opts?: { allowLocalWithoutDisplayableFinal?: boolean },
  ) => {
    const isLocalRun = isLocalRunId?.(runId) ?? false;
    if (isLocalRun) {
      forgetLocalRunId?.(runId);
      if (!opts?.allowLocalWithoutDisplayableFinal) {
        return;
      }
    }
    if (hasConcurrentActiveRun(runId)) {
      pendingHistoryRefresh = true;
      return;
    }
    const activeId = state.activeChatRunId;
    if (activeId && activeId !== runId && !sessionRuns.has(activeId)) {
      pendingHistoryRefresh = true;
      return;
    }
    pendingHistoryRefresh = false;
    void loadHistory?.();
  };

  const isSameSessionKey = (left: string | undefined, right: string | undefined): boolean => {
    const normalizedLeft = (left ?? "").trim().toLowerCase();
    const normalizedRight = (right ?? "").trim().toLowerCase();
    if (!normalizedLeft || !normalizedRight) {
      return false;
    }
    if (normalizedLeft === normalizedRight) {
      return true;
    }
    const parsedLeft = parseAgentSessionKey(normalizedLeft);
    const parsedRight = parseAgentSessionKey(normalizedRight);
    if (parsedLeft && parsedRight) {
      return parsedLeft.agentId === parsedRight.agentId && parsedLeft.rest === parsedRight.rest;
    }
    if (parsedLeft) {
      return parsedLeft.rest === normalizedRight;
    }
    if (parsedRight) {
      return normalizedLeft === parsedRight.rest;
    }
    return false;
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
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
    const priorActiveChatRunId = state.activeChatRunId;
    noteSessionRun(evt.runId);
    if (!state.activeChatRunId && !isLocalBtwRunId?.(evt.runId)) {
      state.activeChatRunId = evt.runId;
    }
    if (evt.state === "delta") {
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) {
        return;
      }
      chatLog.updateAssistant(displayText, evt.runId);
      setActivityStatus("streaming");
    }
    if (evt.state === "final") {
      const isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
      const wasActiveRun = priorActiveChatRunId === evt.runId;
      if (!evt.message && isLocalBtwRun) {
        forgetLocalBtwRunId?.(evt.runId);
        noteFinalizedRun(evt.runId);
        tui.requestRender();
        return;
      }
      if (!evt.message) {
        maybeRefreshHistoryForRun(evt.runId, {
          allowLocalWithoutDisplayableFinal: true,
        });
        chatLog.dropAssistant(evt.runId);
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle" });
        tui.requestRender();
        return;
      }
      if (isCommandMessage(evt.message)) {
        maybeRefreshHistoryForRun(evt.runId);
        const text = extractTextFromMessage(evt.message);
        if (text) {
          chatLog.addSystem(text);
        }
        finalizeRun({ runId: evt.runId, wasActiveRun, status: "idle" });
        tui.requestRender();
        return;
      }
      maybeRefreshHistoryForRun(evt.runId);
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";

      const finalText = streamAssembler.finalize(
        evt.runId,
        evt.message,
        state.showThinking,
        evt.errorMessage,
      );
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
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = priorActiveChatRunId === evt.runId;
      chatLog.addSystem("run aborted");
      terminateRun({ runId: evt.runId, wasActiveRun, status: "aborted" });
      maybeRefreshHistoryForRun(evt.runId);
    }
    if (evt.state === "error") {
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = priorActiveChatRunId === evt.runId;
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      terminateRun({ runId: evt.runId, wasActiveRun, status: "error" });
      maybeRefreshHistoryForRun(evt.runId);
    }
    tryFlushPendingHistoryRefresh();
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as AgentEvent;
    syncSessionKey();
    // Agent events (tool streaming, lifecycle) are emitted per-run. Filter against the
    // active chat run id, not the session id. Tool results can arrive after the chat
    // final event, so accept finalized runs for tool updates.
    const isActiveRun = evt.runId === state.activeChatRunId;
    const isKnownRun = isActiveRun || sessionRuns.has(evt.runId) || finalizedRuns.has(evt.runId);
    if (!isKnownRun) {
      return;
    }
    if (evt.stream === "tool") {
      const verbose = state.sessionInfo.verboseLevel ?? "off";
      const allowToolEvents = verbose !== "off";
      const allowToolOutput = verbose === "full";
      if (!allowToolEvents) {
        return;
      }
      const data = evt.data ?? {};
      const phase = asString(data.phase, "");
      const toolCallId = asString(data.toolCallId, "");
      const toolName = asString(data.name, "tool");
      if (!toolCallId) {
        return;
      }
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args);
      } else if (phase === "update") {
        if (!allowToolOutput) {
          return;
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
      tui.requestRender();
      return;
    }
    if (evt.stream === "lifecycle") {
      if (!isActiveRun) {
        return;
      }
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start") {
        setActivityStatus("running");
      }
      if (phase === "end") {
        setActivityStatus("idle");
      }
      if (phase === "error") {
        setActivityStatus("error");
      }
      tui.requestRender();
    }
  };

  const handleBtwEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as BtwEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (evt.kind !== "btw") {
      return;
    }
    const question = evt.question.trim();
    const text = evt.text.trim();
    if (!question || !text) {
      return;
    }
    btw.showResult({
      question,
      text,
      isError: evt.isError,
    });
    tui.requestRender();
  };

  return { handleChatEvent, handleAgentEvent, handleBtwEvent };
}
