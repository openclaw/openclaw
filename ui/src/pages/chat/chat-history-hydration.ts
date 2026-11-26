import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import {
  isVisibleChatHistoryMessage,
  visibleChatHistoryMessages,
} from "../../lib/chat/message-visibility.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { formatMissingOperatorReadScopeMessage } from "../../lib/permission-error.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import { subscribeToSharedRequest } from "../../lib/shared-request-subscription.ts";
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
  commitCurrentChatHistorySnapshot,
} from "./chat-history-snapshot.ts";
import {
  beginHistoryRequest,
  chatHistoryRequests,
  ownsHistoryRequest,
  acceptsHistoryResult,
  resetChatHistoryProjection,
  retireInitialChatSnapshot,
  setChatHistoryLoad,
  setChatHistoryRetrying,
} from "./chat-history-state.ts";
import {
  materializeVisibleAssistantStreamMessages,
  historyStreamVisibility,
  readRunProjections,
  applyHistoryRun,
} from "./chat-history-stream.ts";
import {
  applyChatPendingInputs,
  loadOwnCancelledInputs,
  mayRestoreOwnCancelledInputs,
} from "./chat-pending-inputs.ts";
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
  historyReplacedVisibleStream,
  visibleAssistantStreamParts,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
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
  const requests = chatHistoryRequests(state);
  requests.historyRead?.abort();
  const read = new AbortController();
  requests.historyRead = read;
  const ownership = beginHistoryRequest(state, client, connectionEpoch, sessionKey, requestAgentId);
  const isCurrent = () =>
    !read.signal.aborted && state.sessions === sessions && acceptsHistoryResult(state, ownership);
  const captureRun = () => captureChatHistoryRun(state, isCurrent);
  const readRuns = () => readRunProjections(state, sessionKey, requestAgentId);
  const previousRunProjections = readRuns();
  const previousRunId = state.chatRunId;
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
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
        signal: read.signal,
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
      // Subscription admission owns live/approval custody. Release this read's
      // wait without aborting that independent subscription's acknowledgement.
      const ready = await subscribeToSharedRequest(
        { promise: admission, subscribers: new Set<AbortController>() },
        read,
        read.signal,
      );
      if (!isCurrent()) {
        return undefined;
      }
      if (admission === requests.subscriptionReady) {
        if (!ready) {
          if (mayRestoreOwnCancelledInputs(state)) {
            await loadOwnCancelledInputs(state, isCurrent);
          }
          if (!isCurrent()) {
            return undefined;
          }
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
    let response = await request(readChatHistoryCursor(state));
    if (!isCurrent()) {
      return undefined;
    }
    const cursorReset = isHistoryCursor(response) && response.kind === "reset";
    if (cursorReset) {
      // Retain the rejected cursor until publication so a superseding read
      // repeats the reset and fills any held prefix before adopting its tail.
      response = await request();
      if (!isCurrent()) {
        return undefined;
      }
    }
    if (isHistoryCursor(response) && response.kind === "reset") {
      throw new Error("chat history page request returned a cursor reset");
    }
    // The bounded run may refer to a row on this wire page. A held-gap fill can prepend rows.
    const runResponse = response;
    const run = runResponse.inFlightRun;
    // Idle reads and evicted progress need no ordered replay code.
    const { prepareCheckpointReplay } =
      run && run.events?.length !== 0 ? await import("./chat-history-progress.ts") : {};
    const replayProgress =
      run && prepareCheckpointReplay ? await prepareCheckpointReplay(run) : undefined;
    // First history has no held transcript to reconcile. Load recovery only
    // after other async prerequisites, before capturing the state it may retain.
    const { fillHeldHistoryGap, reconcileHistoryTail } =
      !isHistoryCursor(response) && state.currentSessionId
        ? await import("./chat-history-held-gap.ts")
        : { fillHeldHistoryGap: undefined, reconcileHistoryTail: undefined };
    if (!isCurrent()) {
      return undefined;
    }
    // Cursor resets may return a bounded tail, not a replacement display window.
    if (
      cursorReset &&
      !isHistoryCursor(response) &&
      !requests.windowReset?.isCurrent() &&
      fillHeldHistoryGap
    ) {
      response = await fillHeldHistoryGap(
        state,
        client,
        sessionKey,
        requestAgentId,
        response,
        isCurrent,
        read.signal,
      );
      if (!isCurrent()) {
        return undefined;
      }
    }
    // Live history wins even if a pending IndexedDB read settles in the next microtask.
    retireInitialChatSnapshot(state);
    const previousMessages = state.chatMessages;
    const previousPagination = state.chatHistoryPagination;
    const previousSessionId = state.currentSessionId ?? null;
    const previousDisplayedLeafEntryId = state.chatDisplayedLeafEntryId;
    const previousHistoryState = readChatHistoryState(state, readChatHistoryCursor(state));
    // Preserve wire metadata before the display and roster owners derive their projections.
    const historyState = response.stateRevision
      ? {
          stateRevision: {
            ...response.stateRevision,
            commands: response.metadata
              ? response.stateRevision.commands
              : previousHistoryState?.stateRevision.commands,
          },
          commands: response.metadata ? response.metadata.commands : previousHistoryState?.commands,
          pendingInputs: response.pendingInputs,
          sessionInfo: response.sessionInfo,
        }
      : null;
    // Fence lifecycle changes before either kind of authoritative history is applied.
    const runProjectionsBeforeApply = readRuns();
    const applyRun = (
      currentRunProjections: typeof runProjectionsBeforeApply,
      resetStream: boolean,
      observedRunActivity?: boolean,
    ) =>
      applyHistoryRun(
        state,
        runResponse,
        [previousRunProjections, runProjectionsBeforeApply, currentRunProjections],
        resetStream,
        replayProgress,
        observedRunActivity,
      );
    const commitSnapshot = () =>
      commitCurrentChatHistorySnapshot(
        state,
        response.deltaCursor ?? null,
        response.sessionInfo,
        historyState,
      );
    const applyInputs = () => {
      applyChatPendingInputs(state, response.pendingInputs, {
        queriedRunIds: inputRunIds,
        receipts:
          !previousSessionId || previousSessionId === state.currentSessionId
            ? response.inputReceipts
            : undefined,
      });
      state.chatQueueModeOverride = response.sessionInfo?.queueMode;
      state.chatEffectiveQueueMode = response.sessionInfo?.effectiveQueueMode;
    };
    if (isHistoryCursor(response)) {
      if (!response.sessionInfo) {
        throw new Error("chat history delta omitted uncached session metadata");
      }
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
      applyInputs();
      applyRun(historyProjection.runs, !state.chatRunId || state.chatRunId === previousRunId);
      commitSnapshot();
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
    const res = response;
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
      !requests.windowReset?.isCurrent() &&
      res.windowReset !== true &&
      (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId);
    const reconciledHistory =
      retainsTranscriptIdentity && reconcileHistoryTail
        ? reconcileHistoryTail({
            sameLeaf:
              previousDisplayedLeafEntryId === undefined ||
              previousDisplayedLeafEntryId === nextDisplayedLeafEntryId,
            nextMessages: visibleMessages,
            nextPagination,
            nextSessionId,
            previousMessages: previousTerminalMessages,
            previousPagination,
            previousSessionId,
          })
        : null;
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
    delete requests.windowReset;
    state.currentSessionId = nextSessionId;
    applyInputs();
    commitSnapshot();
    if (
      state.reconnectResumeSessionId &&
      state.reconnectResumeSessionId !== state.currentSessionId
    ) {
      state.reconnectResumeSessionId = null;
    }
    state.chatVerboseLevel = res.verboseLevel ?? null;
    const observedRunActivity = Boolean(
      res.inFlightRun && state.knownAgentRunIds?.has(res.inFlightRun.runId),
    );
    const resetStream = !state.chatRunId || state.chatRunId === previousRunId;
    if (resetStream) {
      const streamReconciliation = historyStreamVisibility(
        state,
        state.chatRunId ? true : undefined,
      );
      const pruneKeyed = () => {
        for (const message of state.chatMessages) {
          prunePersistedAssistantStreamSegments(state, message);
        }
      };
      const publishStream = (
        opts?: Parameters<typeof materializeVisibleAssistantStreamMessages>[2],
      ) =>
        publishChatSessionProjectionMessages(
          state,
          materializeVisibleAssistantStreamMessages(state.chatMessages, state, opts),
        );
      pruneKeyed();
      const parts = visibleAssistantStreamParts(state, streamReconciliation);
      // The live snapshot already excludes durable bytes. Equal text can be a
      // distinct new occurrence, so only item identity can retire its live copy.
      const historyReplacedStream =
        !res.inFlightRun &&
        historyReplacedVisibleStream(state.chatMessages, parts, streamReconciliation);
      const liveToolIds = state.toolStreamOrder ?? [];
      if (
        state.chatRunId &&
        (parts.length > 0 || liveToolIds.length > 0) &&
        !isChatRunRecoveryStatus(state.chatRunStartup)
      ) {
        reconcileChatRunStartup(state, { state: "activity", runId: state.chatRunId });
      }
      const persistedToolStreamIds = persistedCurrentToolStreamIds(state.chatMessages, state);
      const allToolsPersisted = liveToolIds.every((id) => persistedToolStreamIds.has(id));
      const reconcileToolStream = () => {
        if (allToolsPersisted) {
          resetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
        }
      };
      if (!parts.length || historyReplacedStream) {
        if (state.chatRunId && historyReplacedStream) {
          retainPersistedStreamPrefix(state);
        }
        reconcileToolStream();
      } else if (!state.chatRunId) {
        publishStream();
        resetToolStream(state);
      } else if (persistedToolStreamIds.size) {
        publishStream({
          includeCurrent: false,
          requirePersistedTool: !allToolsPersisted,
          persistCommentary: true,
        });
        if (!visibleCurrentAssistantStreamTail(state, streamReconciliation.isHiddenStreamText)) {
          state.chatStreamStartedAt = null;
        }
        pruneKeyed();
        reconcileToolStream();
      }
      if (!state.chatRunId) {
        state.chatStream = null;
        state.chatStreamStartedAt = null;
      }
    }

    applyRun(historyProjection.runs, resetStream, observedRunActivity);

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
    const failedRead = requests.historyRead;
    const ownsFailure = () =>
      requests.historyRead === failedRead &&
      state.sessionKey === sessionKey &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch;
    if (mayRestoreOwnCancelledInputs(state)) {
      await loadOwnCancelledInputs(state, ownsFailure);
    }
    if (!ownsFailure()) {
      return undefined;
    }
    setChatHistoryLoad(state, {
      phase: "failed",
      sessionKey,
      requestAgentId,
      startup: method === "chat.startup",
      message: missingReadScope
        ? formatMissingOperatorReadScopeMessage("session history")
        : formatChatHistoryLoadError(err),
      retryable:
        isRetryableChatReadError(err, method) ||
        (err instanceof GatewayRequestError && err.retryable),
    });
  } finally {
    if (requests.historyRead === read) {
      delete requests.historyRead;
    }
    if (ownsHistoryRequest(state, ownership)) {
      setChatHistoryRetrying(state, "history", false);
      state.chatLoading = false;
    }
  }
  return undefined;
}
