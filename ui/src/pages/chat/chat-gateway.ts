import {
  hasSessionProjectionAcceptedFinal,
  isSessionProjectionErrorMessage,
  readSessionMessageIdentity,
  reduceSessionProjectionRunEvent,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { projectAssistantDisplayContent } from "../../../../src/shared/assistant-display-content.js";
import { t } from "../../i18n/index.ts";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  isHiddenAssistantStreamText,
  isSilentReplyStream,
  shouldHideAssistantChatMessage,
} from "../../lib/chat/message-visibility.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { isUiGlobalSessionKey, resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import type { ChatEventPayload } from "./chat-history.ts";
import { withChatReasoning } from "./chat-reasoning.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjectionMessages,
  readChatSessionProjectionScope,
  setChatRunOwner,
  publishChatSessionProjection,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunLifecycle,
  setChatRunError,
} from "./run-lifecycle.ts";
import { appendChatMessageToCache, readChatMessagesFromCache } from "./session-message-cache.ts";
import { persistedSteerTargetRunId, replaceChatStream } from "./stream-causal-boundary.ts";
import {
  appendTerminalAssistantMessage,
  clearToolStreamSegments,
  terminalMessageReplacesVisibleStream,
} from "./stream-reconciliation.ts";
import {
  authoritativeHistoryAppliedForRun,
  normalizeFinalAssistantMessage,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

export type { ChatEventPayload } from "./chat-history.ts";

function isPendingLocalChatRun(state: ChatState, runId: string): boolean {
  return state.chatQueue.some((item) => item.sendRunId === runId && item.sendState === "sending");
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  const candidate = asRecord(message);
  return candidate?.role === "assistant" && Array.isArray(candidate.content) ? candidate : null;
}

function formatGatewayErrorDetail(payload: ChatEventPayload): string | null {
  const detail = payload.errorDetail;
  if (!detail || detail.providerRuntimeFailureKind !== "auth_refresh") {
    return null;
  }
  const lines = [
    detail.provider ? `Provider: ${detail.provider}` : undefined,
    detail.httpStatus ? `HTTP status: ${detail.httpStatus}` : undefined,
    detail.failoverReason ? `Reason: ${detail.failoverReason}` : undefined,
    detail.providerErrorType ? `Type: ${detail.providerErrorType}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

function resolveGatewayErrorText(
  payload: ChatEventPayload,
  message: Record<string, unknown> | null,
): string {
  const errorText = payload.errorMessage?.trim();
  if (errorText) {
    if (
      payload.state === "error" &&
      (payload.errorKind === "state_contention" ||
        payload.stopReason === "aborted-partial-persistence-failed")
    ) {
      return errorText;
    }
    const summary =
      errorText.startsWith("⚠️") || errorText.startsWith("Error:")
        ? errorText
        : `Error: ${errorText}`;
    const detail = formatGatewayErrorDetail(payload);
    return detail ? `${summary}\n\n${detail}` : summary;
  }
  const messageText = message ? extractText(message)?.trim() : null;
  return messageText || "chat error";
}

export function handleChatGatewayEvent(state: ChatState, incoming?: ChatEventPayload) {
  if (!incoming) {
    return null;
  }
  const wireMessage = asRecord(incoming.message);
  const displayMessage =
    wireMessage && incoming.state !== "delta" && incoming.state !== "status"
      ? projectAssistantDisplayContent(wireMessage)
      : incoming.message;
  const displayEvent =
    displayMessage === incoming.message ? incoming : { ...incoming, message: displayMessage };
  const payload =
    displayEvent.state === "aborted" && displayEvent.stopReason === "auth-revoked"
      ? { ...displayEvent, errorMessage: t("chat.providerAccessRemoved") }
      : displayEvent;
  const errorKind =
    payload.state === "error" && payload.errorKind === "state_contention"
      ? "state_contention"
      : payload.state === "error" && payload.stopReason === "aborted-partial-persistence-failed"
        ? "stop"
        : payload.errorDetail?.providerRuntimeFailureKind === "auth_refresh"
          ? "auth_refresh"
          : undefined;
  const injectedMessageId =
    payload.state === "final" && payload.seq === 0 && payload.runId?.startsWith("inject-")
      ? payload.runId.slice("inject-".length)
      : null;
  const sessionMatches = visibleSessionMatches(state, payload.sessionKey, payload.agentId);
  const incomingFinalMessage =
    payload.state === "final"
      ? sessionMatches && (!state.chatRunId || payload.runId === state.chatRunId)
        ? withChatReasoning(state, normalizeFinalAssistantMessage(payload.message), payload.runId)
        : normalizeFinalAssistantMessage(payload.message)
      : null;
  // Only seq-zero inject deliveries encode a row ID: ordinary runs start at one
  // and may use any client-selected ID. Reconcile with session.message/history.
  const normalizedFinalMessage =
    injectedMessageId && incomingFinalMessage
      ? {
          ...incomingFinalMessage,
          __openclaw: { ...asRecord(incomingFinalMessage["__openclaw"]), id: injectedMessageId },
        }
      : incomingFinalMessage;
  const terminalAfterSequence = (
    messages: unknown[],
    runId: string | null | undefined,
  ): number | null | undefined => {
    // Display projections own an unpersisted tail; a durable row cannot claim
    // that occurrence by run identity alone.
    if (displayMessage !== incoming.message) {
      return null;
    }
    const latestSteer = runId
      ? messages.findLast(
          (entry) =>
            readSessionMessageIdentity(entry)?.role === "user" &&
            persistedSteerTargetRunId(entry) === runId,
        )
      : undefined;
    // A known steer with no position still fences earlier same-run answers.
    return latestSteer ? (readSessionMessageIdentity(latestSteer)?.sequence ?? null) : undefined;
  };
  const hadActiveRunBeforeEvent = state.chatRunId !== null;
  const activeRunMatches =
    state.chatRunId !== null &&
    typeof payload.runId === "string" &&
    payload.runId === state.chatRunId;
  const authoritativeTerminalMatches = Boolean(
    payload.runId && authoritativeHistoryAppliedForRun(state, payload.runId) && sessionMatches,
  );
  if (!sessionMatches) {
    if (payload.state === "final") {
      const finalMessage = normalizedFinalMessage;
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        const cacheAgentId = isUiGlobalSessionKey(payload.sessionKey)
          ? (payload.agentId ?? resolveUiDefaultAgentId(state))
          : payload.agentId;
        if (state.chatMessagesBySession) {
          const cachedMessages = readChatMessagesFromCache(state.chatMessagesBySession, state, {
            sessionKey: payload.sessionKey,
            agentId: cacheAgentId,
          });
          if (
            injectedMessageId &&
            cachedMessages.some(
              (message) => readSessionMessageIdentity(message)?.id === injectedMessageId,
            )
          ) {
            return null;
          }
          const afterSequence = terminalAfterSequence(cachedMessages, payload.runId);
          appendChatMessageToCache(
            state.chatMessagesBySession,
            state,
            { sessionKey: payload.sessionKey, agentId: cacheAgentId },
            finalMessage,
            injectedMessageId
              ? { messageId: injectedMessageId }
              : afterSequence === undefined
                ? payload
                : { ...payload, afterSequence },
          );
        }
      }
    }
    return null;
  }
  if (injectedMessageId) {
    if (
      normalizedFinalMessage &&
      !shouldHideAssistantChatMessage(normalizedFinalMessage) &&
      !state.chatMessages.some(
        (message) => readSessionMessageIdentity(message)?.id === injectedMessageId,
      )
    ) {
      reduceChatSessionProjection(state, {
        type: "messagePersisted",
        message: normalizedFinalMessage,
      });
    }
    return "injected";
  }
  const scope = readChatSessionProjectionScope(state);
  const publishVisibleTerminal = (
    message: Record<string, unknown>,
    visibleMessages: unknown[],
    runId: string | null | undefined,
  ): void => {
    const event = payload as ChatEventPayload & { messageId?: unknown; messageSeq?: unknown };
    // A pre-steer durable reply cannot claim a later final from the same run.
    // This is an identity fence; the thread builder owns presentation order.
    const afterSequence = terminalAfterSequence(state.chatMessages, runId);
    publishChatSessionProjectionMessages(state, visibleMessages, {
      scope,
      event: {
        type: "messagePersisted",
        message,
        envelope: {
          ...(afterSequence === undefined ? {} : { afterSequence }),
          ...(runId ? { runId } : {}),
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          ...(event.messageSeq === undefined ? {} : { messageSeq: event.messageSeq }),
        },
      },
    });
  };
  const projectedRun =
    payload.runId && payload.state !== "status"
      ? reduceSessionProjectionRunEvent(
          getChatSessionProjection(state, scope),
          normalizedFinalMessage ? { ...payload, message: normalizedFinalMessage } : payload,
          scope,
        )
      : null;
  if (projectedRun) {
    publishChatSessionProjection(state, projectedRun.projection);
  }
  const terminalRunId = payload.runId ?? state.chatRunId;
  const reconcileOwnedTerminalRun = () => {
    const terminalStatus = projectedRun?.currentRun?.status;
    if (
      !payload.runId ||
      payload.runId !== state.chatRunId ||
      !terminalStatus ||
      terminalStatus === "streaming"
    ) {
      return;
    }
    clearToolStreamSegments(state);
    const sessionKeys = [state.sessionKey, payload.sessionKey];
    if (terminalStatus === "yielded") {
      reconcileChatRunLifecycle(state, {
        yielded: true,
        runId: terminalRunId,
        sessionKey: state.sessionKey,
        sessionKeys,
        clearLocalRun: true,
        clearChatStream: true,
      });
      return;
    }
    const sessionStatus =
      terminalStatus === "completed"
        ? ("done" as const)
        : terminalStatus === "aborted"
          ? ("killed" as const)
          : terminalStatus === "timeout"
            ? ("timeout" as const)
            : ("failed" as const);
    reconcileChatRunLifecycle(state, {
      outcome: terminalStatus === "completed" ? "done" : "interrupted",
      sessionStatus,
      errorMessage: payload.errorMessage?.trim()
        ? resolveGatewayErrorText(payload, null)
        : undefined,
      runId: terminalRunId,
      sessionKey: state.sessionKey,
      sessionKeys,
      clearLocalRun: true,
      clearChatStream: true,
      armLocalTerminalReconcile: hadActiveRunBeforeEvent && activeRunMatches,
    });
  };
  const previousTerminalRun = projectedRun?.previousRun;
  if (
    previousTerminalRun &&
    previousTerminalRun.status !== "streaming" &&
    projectedRun.currentRun?.status !== "streaming"
  ) {
    if (payload.state === "delta") {
      return null;
    }
    if (payload.state === "error" || payload.state === "aborted") {
      const pendingRunId = state.chatQueue.find(
        (item) => item.sendState === "sending" && item.sendRunId,
      )?.sendRunId;
      const diagnosticOwnerRunId =
        state.chatRunId ?? pendingRunId ?? state.lastLocalTerminalReconcile?.runId;
      if (
        diagnosticOwnerRunId === payload.runId &&
        payload.errorMessage?.trim() &&
        projectedRun.currentRun?.errorMessage !== previousTerminalRun.errorMessage
      ) {
        // Late diagnostics belong to the active, pending, or latest locally terminal run;
        // publishing them over a newer response falsely marks the new run failed.
        setChatRunError(state, resolveGatewayErrorText(payload, null), payload.runId, errorKind);
      }
      if (payload.state === "error") {
        reconcileOwnedTerminalRun();
        return "error";
      }
    }
    const incomingFinal = normalizedFinalMessage;
    if (
      payload.state === "aborted" ||
      (payload.state === "final" &&
        (!incomingFinal ||
          shouldHideAssistantChatMessage(incomingFinal) ||
          hasSessionProjectionAcceptedFinal(previousTerminalRun, incomingFinal)))
    ) {
      reconcileOwnedTerminalRun();
      return payload.state;
    }
  }
  if (
    !state.chatRunId &&
    (!previousTerminalRun ||
      previousTerminalRun.status === "streaming" ||
      projectedRun?.currentRun?.status === "streaming") &&
    typeof payload.runId === "string" &&
    (payload.state !== "status" || isPendingLocalChatRun(state, payload.runId))
  ) {
    if (payload.state === "status") {
      adoptStartedChatRun(state, payload.runId, Date.now());
    } else {
      state.chatRunId = payload.runId;
      setChatRunOwner(state, payload.runId);
      state.chatRunError = null;
      state.chatStreamStartedAt ??= Date.now();
    }
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizedFinalMessage;
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        publishVisibleTerminal(finalMessage, [...state.chatMessages, finalMessage], payload.runId);
        return null;
      }
      return "final";
    }
    return null;
  }

  if (activeRunMatches && displayMessage !== incoming.message) {
    // An empty display tail is authoritative too; do not materialize an older live copy.
    replaceChatStream(state, extractText(displayMessage) ?? null);
  }

  const materializeVisibleStream = (
    materializeOpts: Parameters<typeof materializeVisibleAssistantStreamMessages>[2] = {},
  ) => materializeVisibleAssistantStreamMessages(state.chatMessages, state, materializeOpts);
  const publishTerminalStream = (
    message: Record<string, unknown>,
    visibleMessages: unknown[],
    disposition?: Parameters<typeof rememberLiveTerminalRun>[2],
    replaceStream = true,
  ) => {
    const live = rememberLiveTerminalRun(message, terminalRunId, disposition);
    publishVisibleTerminal(
      message,
      replaceStream
        ? appendTerminalAssistantMessage(visibleMessages, live)
        : [...visibleMessages, live],
      terminalRunId,
    );
  };
  const publishInterruptedStream = () => {
    publishChatSessionProjectionMessages(state, materializeVisibleStream(), { scope });
    // Message-less terminal events still own the retained partial's outcome
    // until saved history replaces this live projection.
    rememberLiveTerminalRun(
      state.chatMessages.findLast((message) => transcriptRunId(message) === terminalRunId),
      terminalRunId,
      payload.state === "aborted"
        ? "aborted"
        : projectedRun?.currentRun?.status === "timeout"
          ? "timeout"
          : "error",
    );
  };
  if (payload.state === "status") {
    if (!payload.runId || payload.runId !== state.chatRunId) {
      return null;
    }
    const status = payload.retry
      ? typeof payload.seq === "number" && {
          phase: "retrying" as const,
          seq: payload.seq,
          message: t("chat.startupStatus.retrying", {
            attempt: String(payload.retry.attempt),
            maxAttempts: String(payload.retry.maxAttempts),
          }),
        }
      : payload.phase && {
          phase: payload.phase,
          ...(payload.seq === undefined ? {} : { seq: payload.seq }),
        };
    if (status) {
      reconcileChatRunStartup(state, {
        state: "status",
        runId: payload.runId,
        ...status,
      });
    }
    return payload.state;
  }

  if (payload.state === "delta") {
    if (payload.runId && payload.runId === state.chatRunId) {
      reconcileChatRunStartup(state, { state: "activity", runId: payload.runId });
    }
    const next = payload.message == null ? null : (extractText(payload.message) ?? "");
    if (typeof next === "string") {
      const hidden =
        isSilentReplyStream(next) || isAssistantHeartbeatAckForDisplay(payload.message);
      // A replacement retires the previous baseline even when its new text is hidden;
      // ignoring it would keep already-saved text visible beside its durable row.
      if (payload.replace) {
        replaceChatStream(state, hidden ? "" : next);
      } else if (!hidden) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizedFinalMessage;
    if (authoritativeTerminalMatches) {
      // History already owns this run's terminal message. Discard the live
      // projection; terminal cleanup below clears its remaining stream.
    } else if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
      publishTerminalStream(finalMessage, materializeVisibleStream());
    } else {
      publishChatSessionProjectionMessages(state, materializeVisibleStream(), { scope });
    }
    reconcileOwnedTerminalRun();
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      const visibleMessages = materializeVisibleStream({
        replacementMessages: [normalizedMessage],
        includeCurrent: false,
      });
      publishTerminalStream(normalizedMessage, visibleMessages, "aborted");
    } else {
      publishInterruptedStream();
    }
    if (payload.errorMessage?.trim()) {
      setChatRunError(state, resolveGatewayErrorText(payload, null), payload.runId, errorKind);
    }
    reconcileOwnedTerminalRun();
  } else if (payload.state === "error") {
    const payloadMessage = normalizeFinalAssistantMessage(payload.message);
    const visiblePayloadMessage =
      payloadMessage && !shouldHideAssistantChatMessage(payloadMessage) ? payloadMessage : null;
    const projectedErrorMessage = Boolean(
      visiblePayloadMessage &&
      isSessionProjectionErrorMessage(visiblePayloadMessage, payload.errorMessage),
    );
    if (hadActiveRunBeforeEvent) {
      if (visiblePayloadMessage && !projectedErrorMessage) {
        const replacesVisibleStream = terminalMessageReplacesVisibleStream(
          visiblePayloadMessage,
          state,
          {
            isHiddenStreamText: isHiddenAssistantStreamText,
          },
        );
        const visibleMessages = materializeVisibleStream({
          includeCurrent: !replacesVisibleStream,
        });
        publishTerminalStream(
          visiblePayloadMessage,
          visibleMessages,
          projectedRun?.currentRun?.status === "timeout" ? "timeout" : "error",
          replacesVisibleStream,
        );
      } else {
        publishInterruptedStream();
      }
    }
    // The shared Gateway projection owns timeout classification; preserve it
    // when publishing selected-session and sidebar terminal status.
    reconcileOwnedTerminalRun();
    setChatRunError(
      state,
      resolveGatewayErrorText(payload, projectedErrorMessage ? visiblePayloadMessage : null),
      payload.runId,
      errorKind,
    );
  }
  if (payload.state !== "delta") {
    // Terminal materialization transfers ownership into chatMessages; retaining
    // the stream segments would render the same run output a second time.
    clearToolStreamSegments(state);
  }
  return payload.state;
}
