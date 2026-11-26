import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import type { prepareCheckpointReplay } from "./chat-history-progress.ts";
import type { ObservedChatHistoryResult } from "./chat-history-snapshot.ts";
import { isChatRunRecoveryStatus, reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import {
  getChatRunOwner,
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunFromSessionRow,
  setChatRunError,
} from "./run-lifecycle.ts";
import { replaceChatStream, retainPersistedStreamPrefix } from "./stream-causal-boundary.ts";
import { materializeVisibleStreamState } from "./stream-reconciliation.ts";

export function materializeVisibleAssistantStreamMessages(
  messages: unknown[],
  state: ChatState,
  opts: {
    includeCurrent?: boolean;
    requirePersistedTool?: boolean;
    replacementMessages?: unknown[];
    persistCommentary?: boolean;
  } = {},
): unknown[] {
  return materializeVisibleStreamState(messages, state, {
    ...opts,
    ...historyStreamVisibility(state, opts.persistCommentary),
  });
}

export function historyStreamVisibility(
  state: ChatState,
  persistCommentary = state.settings?.chatPersistCommentary !== false,
) {
  return {
    persistCommentary,
    isHiddenAssistantMessage: isAssistantHeartbeatAckForDisplay,
    isHiddenStreamText: isHiddenAssistantStreamText,
  };
}

function runProjectionsUnchanged(
  previous: ReturnType<typeof getChatSessionProjection>["runs"],
  current: ReturnType<typeof getChatSessionProjection>["runs"],
  exceptRunId?: string,
): boolean {
  return [previous, current].every((runs) =>
    Object.keys(runs).every((id) => id === exceptRunId || previous[id] === current[id]),
  );
}

function hasExactHistoryTerminal(state: ChatState, runId: string): boolean {
  return state.chatMessages.some((message) => {
    const identity = readSessionMessageIdentity(message);
    const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
    return (
      identity?.role === "assistant" &&
      !identity.isImported &&
      (identity.id !== null || identity.sequence !== null) &&
      identity.runId === runId &&
      metadata?.runTerminal === true
    );
  });
}

export function readRunProjections(state: ChatState, sessionKey: string, agentId?: string) {
  return getChatSessionProjection(
    state,
    readChatSessionProjectionScope(state, { sessionKey, agentId }),
  ).runs;
}

export function applyHistoryRun(
  state: ChatHistoryHost,
  {
    inFlightRun: run,
    messages,
    sessionInfo,
    observation: { run: historyRun },
  }: Pick<ObservedChatHistoryResult, "inFlightRun" | "messages" | "sessionInfo" | "observation">,
  [previousRunProjections, runProjectionsBeforeApply, currentRunProjections]: [
    atRead: ReturnType<typeof readRunProjections>,
    beforeApply: ReturnType<typeof readRunProjections>,
    afterMerge: ReturnType<typeof readRunProjections>,
  ],
  resetStream: boolean,
  replayProgress?: Awaited<ReturnType<typeof prepareCheckpointReplay>>,
  observedRunActivity?: boolean,
): void {
  const hasOtherSendingRun = (runId: string) =>
    state.chatQueue.some(
      (item) => item.sendState === "sending" && item.sendRunId && item.sendRunId !== runId,
    );
  const inFlightRunId = run?.runId?.trim();
  if (!inFlightRunId || !run) {
    if (
      !sessionInfo ||
      !runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)
    ) {
      return;
    }
    const localRunId = state.chatRunId?.trim();
    if (
      localRunId &&
      sessionInfo.lastRunId !== localRunId &&
      historyRun &&
      !hasOtherSendingRun(localRunId) &&
      reconcileChatRunFromSessionRow(state, sessionInfo, {
        publishRunStatus: false,
        historyRun,
      })
    ) {
      // Idle history retires the observed run without borrowing a later run's outcome.
      return;
    }
    const terminalRunId =
      sessionInfo.lastRunId ??
      (localRunId && hasExactHistoryTerminal(state, localRunId) ? localRunId : undefined);
    const knownRun = terminalRunId ? currentRunProjections[terminalRunId] : undefined;
    if (
      terminalRunId &&
      (sessionInfo.status === "done" ||
        sessionInfo.status === "failed" ||
        sessionInfo.status === "killed" ||
        sessionInfo.status === "timeout") &&
      sessionInfo.hasActiveRun !== true &&
      !isSessionRunStateActive(sessionInfo) &&
      (!state.chatRunId || state.chatRunId === terminalRunId) &&
      !hasOtherSendingRun(terminalRunId) &&
      ((sessionInfo.status !== "killed" && !knownRun) ||
        state.chatRunId === terminalRunId ||
        getChatRunOwner(state) === terminalRunId)
    ) {
      // A copied row cannot reclaim retired display ownership. The pane retains
      // its accepted owner past active cleanup; unseen runs recover through the
      // reducer, whose full diagnostic wins over the bounded history summary.
      const failureNotice = getChatSessionProjection(state).entries.findLast(
        (entry) =>
          entry.identity?.runId === terminalRunId &&
          !entry.identity.isImported &&
          entry.identity.role === "custom" &&
          asOptionalRecord(entry.message)?.customType === "run-failed-before-reply",
      );
      const failureDetails = asOptionalRecord(asOptionalRecord(failureNotice?.message)?.details);
      const failureKind = failureDetails?.errorKind;
      const errorKind = failureKind === "state_contention" ? failureKind : undefined;
      const failureText = extractText(failureNotice?.message);
      const failureMessage =
        errorKind && failureText && typeof failureDetails?.diagnostic === "string"
          ? `${failureText}\n\n${failureDetails.diagnostic}`
          : failureText;
      const projection = reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId: terminalRunId,
        ...(errorKind ? { errorKind } : {}),
        status:
          sessionInfo.status === "done"
            ? "completed"
            : sessionInfo.status === "timeout"
              ? "timeout"
              : "error",
        suppressErrorNotice: sessionInfo.suppressErrorNotice,
        errorMessage:
          sessionInfo.status === "failed" || sessionInfo.status === "timeout"
            ? (failureMessage ?? sessionInfo.lastRunError)
            : sessionInfo.lastRunError,
      });
      setChatRunOwner(state, terminalRunId);
      const terminal = projection.runs[terminalRunId];
      if (terminal?.errorMessage) {
        if (state.chatRunError?.runId !== terminalRunId || !knownRun?.errorMessage) {
          setChatRunError(
            state,
            terminal.errorMessage,
            terminalRunId,
            terminal.errorKind === "state_contention" ? terminal.errorKind : undefined,
          );
        }
      } else if (
        terminal?.status === "completed" &&
        state.chatRunError?.runId &&
        state.chatRunError.runId !== terminalRunId
      ) {
        state.chatRunError = null;
      }
      reconcileChatRunFromSessionRow(state, sessionInfo, { publishRunStatus: false });
    }
    return;
  }
  const projectedInFlightRun = currentRunProjections[inFlightRunId];
  const activeRunIds = Array.isArray(sessionInfo?.activeRunIds)
    ? sessionInfo.activeRunIds
    : undefined;
  if (
    !isSessionRunStateActive(sessionInfo ?? {}) ||
    (activeRunIds && !activeRunIds.includes(inFlightRunId)) ||
    (projectedInFlightRun && projectedInFlightRun.status !== "streaming")
  ) {
    return;
  }
  // Only a read issued while this pane still owned the old run can replace it.
  // The exact active set proves that custody ended, not how the old run finished.
  // A copied row, a late shared-read consumer, or a different session is not proof.
  const replacesOwnedRun = Boolean(
    state.chatRunId &&
    state.chatRunId !== inFlightRunId &&
    activeRunIds &&
    !activeRunIds.includes(state.chatRunId) &&
    historyRun?.runId === state.chatRunId &&
    historyRun.sessionId === sessionInfo?.sessionId &&
    historyRun.isCurrent() &&
    !hasOtherSendingRun(inFlightRunId),
  );
  if (
    (resetStream &&
      (!state.chatRunId || replacesOwnedRun) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)) ||
    (state.chatRunId === inFlightRunId &&
      projectedInFlightRun?.status === "streaming" &&
      runProjectionsUnchanged(previousRunProjections, currentRunProjections, inFlightRunId))
  ) {
    // Canonical run projections change on every live delta or terminal.
    // Their identity fences ABA races where a run starts and finishes while
    // history is pending; the same live run retains its ordered text baseline.
    adoptStartedChatRun(state, inFlightRunId, Date.now());
    state.chatRunSessionAbortable = run.sessionAbortable === true;
  }
  if (state.chatRunId !== inFlightRunId) {
    return;
  }
  const snapshotStartedAt = asFiniteNumber(run.startedAt);
  const source = run.textFromMessage;
  const persisted = Array.isArray(source)
    ? source.map((index) => extractText(messages?.[index])).join("\n\n")
    : source != null && extractText(messages?.[source]);
  const bufferedText = (persisted || "") + (run.text ?? "");
  const liveMessage = runProjectionsBeforeApply[inFlightRunId]?.message;
  const usesSnapshotText =
    replacesOwnedRun || previousRunProjections[inFlightRunId]?.message === liveMessage;
  // A pending snapshot cannot extend an ordered live baseline, including shrinking replacements.
  const text = usesSnapshotText ? bufferedText : extractText(liveMessage);
  const visible = text && !isHiddenAssistantStreamText(text) ? text : null;
  if (usesSnapshotText) {
    replaceChatStream(state, visible);
    if (persisted) {
      retainPersistedStreamPrefix(state, persisted);
    }
  } else {
    state.chatStream = visible;
  }
  state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
  const markObservedActivity = (hasStartup: boolean) => {
    if (
      (bufferedText ||
        (!hasStartup &&
          state.chatRunStartup?.runId !== inFlightRunId &&
          (observedRunActivity ?? state.knownAgentRunIds?.has(inFlightRunId)))) &&
      !isChatRunRecoveryStatus(state.chatRunStartup)
    ) {
      reconcileChatRunStartup(state, { state: "activity", runId: inFlightRunId });
      return true;
    }
    return false;
  };
  if (replayProgress) {
    replayProgress(state, inFlightRunId, bufferedText, markObservedActivity, usesSnapshotText);
  } else {
    markObservedActivity(false);
  }
}
