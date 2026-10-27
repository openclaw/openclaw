import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import {
  isHiddenAssistantStreamText,
  isVisibleChatHistoryMessage,
  visibleChatHistoryMessages,
} from "../../lib/chat/message-visibility.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import {
  captureChatHistoryRun,
  chatHistoryRequestParams,
  requestSharedHistory,
} from "./chat-history-request.ts";
import { formatChatHistoryLoadError, isRetryableChatReadError } from "./chat-history-retry.ts";
import {
  type ObservedChatHistoryResult,
  isHistoryCursor,
  resolveChatHistoryPagination,
  historySessionId,
  reconcileHistoryTail,
  commitCurrentChatHistorySnapshot,
  clearHistoryCursor,
} from "./chat-history-snapshot.ts";
import {
  beginHistoryRequest,
  chatHistoryRequests,
  ownsHistoryRequest,
  acceptsHistoryResult,
  resetChatHistoryProjection,
  retireInitialChatSnapshot,
  setChatError,
  setChatHistoryLoad,
  setChatHistoryRetrying,
} from "./chat-history-state.ts";
import {
  materializeVisibleAssistantStreamMessages,
  persistsChatCommentary,
  readRunProjections,
  applyHistoryRun,
} from "./chat-history-stream.ts";
import { loadChatLiveTools } from "./chat-live-tools.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { isChatRunRecoveryStatus, reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatHistoryHost, ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  publishChatSessionProjection,
  publishChatSessionProjectionMessages,
} from "./history-merge.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { readChatHistoryCursor, readChatHistoryState } from "./session-message-cache.ts";
import { retainPersistedStreamPrefix } from "./stream-causal-boundary.ts";
import {
  hasVisibleStreamParts,
  historyReplacedVisibleStream,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
  pruneHistoryReplacedStreamSegments,
  prunePersistedAssistantStreamSegments,
  prunePersistedToolStreamMessages,
} from "./stream-segment-pruning.ts";
import { reconcileAuthoritativeTerminalHistory } from "./terminal-message-identity.ts";
import { persistedCurrentToolStreamIds } from "./tool-stream-identity.ts";
import { resetToolStream } from "./tool-stream-state.ts";

export async function hydrateChatHistory(
  state: ChatHistoryHost,
  client: NonNullable<ChatState["client"]>,
  connectionEpoch: number,
  sessions: ChatHistorySessions,
  sessionKey: string,
  requestAgentId: string | undefined,
  method: "chat.history" | "chat.startup",
  inputRunIds: string[],
  requestKeyPrefix: string,
): Promise<ObservedChatHistoryResult | undefined> {
  const ownership = beginHistoryRequest(state, client, connectionEpoch, sessionKey, requestAgentId);
  const isCurrent = () => state.sessions === sessions && acceptsHistoryResult(state, ownership);
  const captureRun = () => captureChatHistoryRun(state, isCurrent);
  const previousRunProjections = readRunProjections(state, sessionKey, requestAgentId);
  const previousRunId = state.chatRunId;
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
  const requests = chatHistoryRequests(state);
  const request = (cursor?: string) => {
    const initialHistory = requests.initialHistory;
    delete requests.initialHistory;
    // A full page already covers a cache restored while its subscription was pending.
    // Keep the exact request check: changed input-run receipts still need a fresh read.
    const requestedCursor =
      method === "chat.startup" &&
      initialHistory?.isCurrent() &&
      initialHistory.paramsKey ===
        JSON.stringify(
          chatHistoryRequestParams(method, sessionKey, requestAgentId, undefined, inputRunIds),
        )
        ? undefined
        : cursor;
    const historyState = readChatHistoryState(state, requestedCursor);
    const key = `${requestKeyPrefix}${requestedCursor === undefined ? "page" : `cursor:${requestedCursor}`}${JSON.stringify(historyState?.stateRevision ?? null)}`;
    const load = requests.historyLoad;
    // Keep pane-level coalescing aligned with the cursor actually sent.
    if (load.phase === "in-flight") {
      load.key = key;
    }
    return requestSharedHistory(
      sessions,
      client,
      key,
      method,
      sessionKey,
      requestAgentId,
      state,
      {
        isCurrent,
        captureRun,
        onRetry: () => {
          if (isCurrent()) {
            setChatHistoryRetrying(state, "history", true);
          }
        },
      },
      requestedCursor,
      inputRunIds,
      historyState,
      initialHistory,
    );
  };
  try {
    let admission = requests.subscriptionReady;
    while (admission) {
      const ready = await admission;
      if (!isCurrent()) {
        return undefined;
      }
      if (admission === requests.subscriptionReady) {
        if (!ready) {
          if (requests.subscriptionError) {
            setChatHistoryLoad(state, {
              phase: "failed",
              sessionKey,
              requestAgentId,
              startup: method === "chat.startup",
              message: requests.subscriptionError,
              retryable: requests.historyLoad.phase === "failed" && requests.historyLoad.retryable,
            });
          }
          return undefined;
        }
        break;
      }
      admission = requests.subscriptionReady;
    }
    // Use a restored cursor when ready, but never hold live history on browser storage.
    if (!isCurrent()) {
      return undefined;
    }
    // The snapshot covers activity emitted before the foreground observer was
    // admitted; subsequent activity arrives through its acknowledged full stream.
    setChatError(state, null);
    let response = await request(readChatHistoryCursor(state));
    if (!isCurrent()) {
      return undefined;
    }
    if (isHistoryCursor(response) && response.kind === "reset") {
      clearHistoryCursor(state, sessionKey, requestAgentId);
      response = await request();
      if (!isCurrent()) {
        return undefined;
      }
    }
    const inFlightEvents =
      isHistoryCursor(response) && response.kind === "reset"
        ? undefined
        : response.inFlightRun?.events;
    const replayAgentEvent = inFlightEvents?.length
      ? (await loadChatLiveTools()).handleAgentEvent
      : undefined;
    if (!isCurrent()) {
      return undefined;
    }
    // Live history wins even if a pending IndexedDB read settles in the next microtask.
    retireInitialChatSnapshot(state);
    const previousMessages = state.chatMessages;
    const previousPagination = state.chatHistoryPagination;
    const previousSessionId = state.currentSessionId ?? null;
    const previousDisplayedLeafEntryId = state.chatDisplayedLeafEntryId;
    const previousHistoryState = readChatHistoryState(state, readChatHistoryCursor(state));
    // Preserve wire metadata before the display and roster owners derive their projections.
    const historyState =
      !(isHistoryCursor(response) && response.kind === "reset") && response.stateRevision
        ? {
            stateRevision: {
              ...response.stateRevision,
              commands: response.metadata
                ? response.stateRevision.commands
                : previousHistoryState?.stateRevision.commands,
            },
            commands: response.metadata
              ? response.metadata.commands
              : previousHistoryState?.commands,
            pendingInputs: response.pendingInputs,
            sessionInfo: response.sessionInfo,
          }
        : null;
    if (isHistoryCursor(response) && response.kind === "delta") {
      if (!response.sessionInfo) {
        throw new Error("chat history delta omitted uncached session metadata");
      }
      const runProjectionsBeforeApply = readRunProjections(state, sessionKey, requestAgentId);
      const runActive = isSessionRunStateActive(response.sessionInfo);
      for (const payload of response.messages) {
        applySessionMessagePayload(state, payload, runActive, { kind: "history-delta" });
      }
      const historyProjection = getChatSessionProjection(state);
      if (Object.hasOwn(response.sessionInfo, "activeLeafEntryId")) {
        state.chatDisplayedLeafEntryId = response.sessionInfo.activeLeafEntryId?.trim() || null;
      }
      state.currentSessionId = response.sessionInfo.sessionId?.trim() || previousSessionId;
      // An accepted delta advances the same transcript generation, not a branch replacement.
      // Carry ownership across its leaf advance; reseeding loses attributed pending sends and runs.
      publishChatSessionProjection(state, {
        ...historyProjection,
        scope: { ...historyProjection.scope, ...readChatSessionProjectionScope(state) },
      });
      applyChatPendingInputs(state, response.pendingInputs, {
        queriedRunIds: inputRunIds,
        receipts:
          !previousSessionId || previousSessionId === state.currentSessionId
            ? response.inputReceipts
            : undefined,
      });
      state.chatQueueModeOverride = response.sessionInfo.queueMode;
      state.chatEffectiveQueueMode = response.sessionInfo.effectiveQueueMode;
      applyHistoryRun({
        replayAgentEvent,
        state,
        run: response.inFlightRun,
        sessionInfo: response.sessionInfo,
        historyRun: response.observation.run,
        previousRunProjections,
        runProjectionsBeforeApply,
        currentRunProjections: historyProjection.runs,
        resetStream: !state.chatRunId || state.chatRunId === previousRunId,
      });
      commitCurrentChatHistorySnapshot(
        state,
        response.deltaCursor ?? null,
        response.sessionInfo,
        historyState,
      );
      return {
        messages: state.chatMessages,
        deltaCursor: response.deltaCursor,
        pendingInputs: response.pendingInputs,
        inputReceipts: response.inputReceipts,
        sessionInfo: response.sessionInfo,
        ...(response.inFlightRun ? { inFlightRun: response.inFlightRun } : {}),
        ...(response.metadata ? { metadata: response.metadata } : {}),
        observation: response.observation,
      };
    }
    if (isHistoryCursor(response)) {
      throw new Error("chat history page request returned a cursor reset");
    }
    const res = response;
    // Fence concurrent run lifecycle before applying the response. A remount
    // may replace the map itself, so compare its canonical run entries.
    const runProjectionsBeforeApply = readRunProjections(state, sessionKey, requestAgentId);
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const nextPagination = resolveChatHistoryPagination(res);
    const nextSessionId = historySessionId(res);
    const visibleMessages = visibleChatHistoryMessages(messages);
    const previousTerminalMessages = reconcileAuthoritativeTerminalHistory({
      host: state,
      previousMessages,
      sessionKey,
      visibleMessages,
    });
    const hasActiveLeafEntryId = Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId");
    const nextDisplayedLeafEntryId = hasActiveLeafEntryId
      ? res.sessionInfo?.activeLeafEntryId?.trim() || null
      : (previousDisplayedLeafEntryId ?? null);
    const retainsTranscriptIdentity =
      res.windowReset !== true &&
      (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) &&
      (previousDisplayedLeafEntryId === undefined ||
        previousDisplayedLeafEntryId === nextDisplayedLeafEntryId);
    const reconciledHistory = reconcileHistoryTail({
      nextMessages: visibleMessages,
      nextPagination,
      nextSessionId,
      previousMessages: retainsTranscriptIdentity ? previousTerminalMessages : [],
      previousPagination,
      previousSessionId,
    });
    const authoritativeMessages = reconciledHistory?.messages ?? visibleMessages;
    const scope = readChatSessionProjectionScope(state, {
      sessionKey,
      agentId: requestAgentId,
      sessionId: nextSessionId,
      ...(hasActiveLeafEntryId ? { activeLeafEntryId: nextDisplayedLeafEntryId } : {}),
    });
    state.chatSubmissions?.observeInitialSession(sessionKey, client, nextSessionId);
    // Only the pane-owned reducer proves which live and pending rows survive;
    // terminal-renderer cleanup must not reclassify them as history. A new
    // session or leaf starts empty.
    const historyProjection = reduceChatSessionProjection(
      state,
      {
        type: "snapshotLoaded",
        messages: authoritativeMessages,
        options: { shouldIncludeMessage: isVisibleChatHistoryMessage },
      },
      {
        scope,
        runActive:
          res.sessionInfo &&
          (typeof res.sessionInfo.hasActiveRun === "boolean" ||
            res.sessionInfo.status !== undefined)
            ? isSessionRunStateActive(res.sessionInfo)
            : undefined,
      },
    );
    if (hasActiveLeafEntryId) {
      state.chatDisplayedLeafEntryId = nextDisplayedLeafEntryId;
    }
    state.chatHistoryPagination = reconciledHistory?.pagination ?? nextPagination;
    state.currentSessionId = nextSessionId;
    applyChatPendingInputs(state, res.pendingInputs, {
      queriedRunIds: inputRunIds,
      receipts:
        !previousSessionId || previousSessionId === nextSessionId ? res.inputReceipts : undefined,
    });
    commitCurrentChatHistorySnapshot(state, res.deltaCursor ?? null, res.sessionInfo, historyState);
    if (
      state.reconnectResumeSessionId &&
      state.reconnectResumeSessionId !== state.currentSessionId
    ) {
      state.reconnectResumeSessionId = null;
    }
    state.chatVerboseLevel = res.verboseLevel ?? null;
    state.chatQueueModeOverride = res.sessionInfo?.queueMode;
    state.chatEffectiveQueueMode = res.sessionInfo?.effectiveQueueMode;
    const observedRunActivity = Boolean(
      res.inFlightRun && state.knownAgentRunIds?.has(res.inFlightRun.runId),
    );
    const resetStream = !state.chatRunId || state.chatRunId === previousRunId;
    if (resetStream) {
      const streamReconciliation = {
        persistCommentary: state.chatRunId ? true : persistsChatCommentary(state),
        isHiddenAssistantMessage: isAssistantHeartbeatAckForDisplay,
        isHiddenStreamText: isHiddenAssistantStreamText,
      };
      for (const message of state.chatMessages) {
        prunePersistedAssistantStreamSegments(state, message);
      }
      const hasVisibleStream = hasVisibleStreamParts(state, streamReconciliation);
      // The live snapshot already excludes durable bytes. Equal text can be a
      // distinct new occurrence, so only item identity can retire its live copy.
      const historyReplacedStream =
        !res.inFlightRun &&
        historyReplacedVisibleStream(state.chatMessages, state, streamReconciliation);
      if (!res.inFlightRun) {
        pruneHistoryReplacedStreamSegments(state.chatMessages, state, streamReconciliation);
      }
      const liveToolIds = state.toolStreamOrder ?? [];
      if (
        state.chatRunId &&
        (hasVisibleStream || liveToolIds.length > 0) &&
        !isChatRunRecoveryStatus(state.chatRunStartup)
      ) {
        reconcileChatRunStartup(state, { state: "activity", runId: state.chatRunId });
      }
      const persistedToolStreamIds = persistedCurrentToolStreamIds(state.chatMessages, state);
      const historyReplacedToolStream =
        liveToolIds.length > 0 && liveToolIds.every((id) => persistedToolStreamIds.has(id));
      const historyReplacedSomeToolStream = persistedToolStreamIds.size > 0;
      const liveToolStreamReplaced = liveToolIds.length === 0 || historyReplacedToolStream;
      const reconcileToolStream = (replaced: boolean, preserveStreamSegments: boolean) => {
        if (replaced) {
          resetToolStream(state, { preserveStreamSegments });
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
        }
      };
      if (!hasVisibleStream || historyReplacedStream) {
        if (state.chatRunId && historyReplacedStream) {
          retainPersistedStreamPrefix(state);
        }
        reconcileToolStream(liveToolStreamReplaced, state.chatRunId !== null);
        if (!state.chatRunId) {
          state.chatStream = null;
          state.chatStreamStartedAt = null;
        }
      } else if (!state.chatRunId) {
        publishChatSessionProjectionMessages(
          state,
          materializeVisibleAssistantStreamMessages(state.chatMessages, state),
        );
        resetToolStream(state);
        state.chatStream = null;
        state.chatStreamStartedAt = null;
      } else if (historyReplacedSomeToolStream) {
        publishChatSessionProjectionMessages(
          state,
          materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
            includeCurrent: false,
            requirePersistedTool: !historyReplacedToolStream,
            persistCommentary: true,
          }),
        );
        if (!visibleCurrentAssistantStreamTail(state, streamReconciliation.isHiddenStreamText)) {
          state.chatStreamStartedAt = null;
        }
        for (const message of state.chatMessages) {
          prunePersistedAssistantStreamSegments(state, message);
        }
        if (!res.inFlightRun) {
          pruneHistoryReplacedStreamSegments(state.chatMessages, state, streamReconciliation);
        }
        reconcileToolStream(historyReplacedToolStream, true);
      }
    }

    applyHistoryRun({
      replayAgentEvent,
      state,
      run: res.inFlightRun,
      observedRunActivity,
      sessionInfo: res.sessionInfo,
      historyRun: res.observation.run,
      previousRunProjections,
      runProjectionsBeforeApply,
      currentRunProjections: historyProjection.runs,
      resetStream,
    });

    return res;
  } catch (err) {
    if (!isCurrent()) {
      return undefined;
    }
    const missingReadScope = isMissingOperatorReadScopeError(err);
    if (missingReadScope) {
      resetChatHistoryProjection(state, requestAgentId);
      state.chatVerboseLevel = null;
    }
    setChatHistoryLoad(state, {
      phase: "failed",
      sessionKey,
      requestAgentId,
      startup: method === "chat.startup",
      message: missingReadScope
        ? formatMissingOperatorReadScopeMessage("existing chat history")
        : formatChatHistoryLoadError(err),
      retryable:
        isRetryableChatReadError(err, method) ||
        (err instanceof GatewayRequestError && err.retryable),
    });
  } finally {
    if (ownsHistoryRequest(state, ownership)) {
      setChatHistoryRetrying(state, "history", false);
      state.chatLoading = false;
    }
  }
  return undefined;
}
