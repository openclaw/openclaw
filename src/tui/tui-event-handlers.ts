import { logDebug } from "../logger.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type { AgentEvent, BtwEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

const TUI_LOG_PREFIX = "tui-events:";

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
  touchBusyActivity?: () => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory?: () => Promise<void>;
  noteLocalRunId?: (runId: string) => void;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
  isLocalBtwRunId?: (runId: string) => boolean;
  forgetLocalBtwRunId?: (runId: string) => void;
  clearLocalBtwRunIds?: () => void;
};

/**
 * Extract a short, human-readable error summary for the status line.
 * Keeps the status bar concise (under ~80 chars) while being informative.
 */
const summarizeError = (raw?: string): string => {
  if (!raw) {
    return "unknown error";
  }
  // Collapse newlines and whitespace to keep status bar single-line
  let stripped = raw
    .replace(/\s+/g, " ")
    .replace(/^⚠️\s*/, "")
    .replace(/^Embedded agent failed before reply:\s*/i, "")
    .trim();
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped
      .replace(/^FailoverError:\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .trim();
  } while (stripped !== prev);
  // Truncate to keep status line readable
  if (stripped.length > 80) {
    return `${stripped.slice(0, 77)}...`;
  }
  return stripped || "unknown error";
};

export function createEventHandlers(context: EventHandlerContext) {
  const {
    chatLog,
    btw,
    tui,
    state,
    setActivityStatus,
    touchBusyActivity,
    refreshSessionInfo,
    loadHistory,
    noteLocalRunId,
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
    state.pendingOptimisticUserMessage = false;
    clearLocalRunIds?.();
    clearLocalBtwRunIds?.();
    btw.clear();
  };

  const flushPendingHistoryRefreshIfIdle = () => {
    if (!pendingHistoryRefresh || state.activeChatRunId) {
      return;
    }
    pendingHistoryRefresh = false;
    void loadHistory?.();
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

  const finalizeRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "idle" | "error";
    errorDetail?: string;
  }) => {
    noteFinalizedRun(params.runId);
    clearActiveRunIfMatch(params.runId);
    flushPendingHistoryRefreshIfIdle();
    if (params.wasActiveRun) {
      if (params.errorDetail && params.status === "error") {
        setActivityStatus(`error: ${params.errorDetail}`);
      } else {
        setActivityStatus(params.status);
      }
    }
    void refreshSessionInfo?.();
  };

  const terminateRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "aborted" | "error";
    errorDetail?: string;
  }) => {
    streamAssembler.drop(params.runId);
    sessionRuns.delete(params.runId);
    clearActiveRunIfMatch(params.runId);
    flushPendingHistoryRefreshIfIdle();
    if (params.wasActiveRun) {
      if (params.errorDetail && params.status === "error") {
        setActivityStatus(`error: ${params.errorDetail}`);
      } else {
        setActivityStatus(params.status);
      }
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

  const maybeRefreshHistoryForRun = (
    runId: string,
    opts?: { allowLocalWithoutDisplayableFinal?: boolean },
  ) => {
    const isLocalRun = isLocalRunId?.(runId) ?? false;
    if (isLocalRun) {
      forgetLocalRunId?.(runId);
      // Local runs with displayable output do not need a history reload.
      if (!opts?.allowLocalWithoutDisplayableFinal) {
        return;
      }
      // Defer the reload if a newer run is active so we preserve the pending
      // user message, then flush once that active run finishes.
      if (state.activeChatRunId && state.activeChatRunId !== runId) {
        pendingHistoryRefresh = true;
        return;
      }
    }
    if (hasConcurrentActiveRun(runId)) {
      return;
    }
    pendingHistoryRefresh = false;
    void loadHistory?.();
  };

  const isSameSessionKey = (left: string | undefined, right: string | undefined): boolean => {
    const normalizedLeft = normalizeLowercaseStringOrEmpty(left);
    const normalizedRight = normalizeLowercaseStringOrEmpty(right);
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
      logDebug(
        `${TUI_LOG_PREFIX} chat event skipped — session mismatch (evt=${evt.sessionKey}, current=${state.currentSessionKey})`,
      );
      return;
    }
    if (evt.state !== "delta") {
      logDebug(
        `${TUI_LOG_PREFIX} chat event: runId=${evt.runId} state=${evt.state} activeChatRunId=${state.activeChatRunId ?? "null"}`,
      );
    }
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") {
        return;
      }
      if (evt.state === "final") {
        logDebug(`${TUI_LOG_PREFIX} chat final for already-finalized run=${evt.runId} (duplicate)`);
        return;
      }
    }
    noteSessionRun(evt.runId);
    if (!state.activeChatRunId && !isLocalBtwRunId?.(evt.runId)) {
      state.activeChatRunId = evt.runId;
      if (state.pendingOptimisticUserMessage) {
        noteLocalRunId?.(evt.runId);
        state.pendingOptimisticUserMessage = false;
      }
    }
    // Refresh stale-busy timer only from the active run's events,
    // so stale-run detection is not suppressed by unrelated run activity.
    if (state.activeChatRunId === evt.runId) {
      touchBusyActivity?.();
    }
    if (evt.state === "delta") {
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) {
        return;
      }
      chatLog.updateAssistant(displayText, evt.runId);
      // Only update activity status for the active run so that stale-run
      // detection is not suppressed by background/same-session runs.
      if (state.activeChatRunId === evt.runId) {
        setActivityStatus("streaming");
      }
    }
    if (evt.state === "final") {
      logDebug(
        `${TUI_LOG_PREFIX} chat final: runId=${evt.runId} hasMessage=${!!evt.message} activeRun=${state.activeChatRunId === evt.runId}`,
      );
      const isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
      const wasActiveRun = state.activeChatRunId === evt.runId;
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
      const errorDetail = stopReason === "error" ? summarizeError(evt.errorMessage) : undefined;
      finalizeRun({
        runId: evt.runId,
        wasActiveRun,
        status: stopReason === "error" ? "error" : "idle",
        errorDetail,
      });
    }
    if (evt.state === "aborted") {
      logDebug(`${TUI_LOG_PREFIX} chat aborted: runId=${evt.runId}`);
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem("run aborted");
      terminateRun({ runId: evt.runId, wasActiveRun, status: "aborted" });
      maybeRefreshHistoryForRun(evt.runId);
    }
    if (evt.state === "error") {
      logDebug(
        `${TUI_LOG_PREFIX} chat error: runId=${evt.runId} error=${evt.errorMessage ?? "unknown"}`,
      );
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      terminateRun({
        runId: evt.runId,
        wasActiveRun,
        status: "error",
        errorDetail: summarizeError(evt.errorMessage),
      });
      maybeRefreshHistoryForRun(evt.runId);
    }
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
    // Refresh stale-busy timer on any event for an active or known run.
    if (isActiveRun) {
      touchBusyActivity?.();
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
      logDebug(`${TUI_LOG_PREFIX} agent lifecycle: runId=${evt.runId} phase=${phase}`);
      if (phase === "start") {
        setActivityStatus("running");
      }
      if (phase === "end") {
        setActivityStatus("idle");
      }
      if (phase === "error") {
        const lifecycleError = typeof evt.data?.error === "string" ? evt.data.error : undefined;
        setActivityStatus(lifecycleError ? `error: ${summarizeError(lifecycleError)}` : "error");
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
