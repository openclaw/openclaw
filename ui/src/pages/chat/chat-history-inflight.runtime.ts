import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import {
  hasOtherSendingRun,
  runProjectionsUnchanged,
  type ChatHistoryRunApplication,
} from "./chat-history-stream.ts";
import { isChatRunRecoveryStatus, reconcileChatRunStartup } from "./chat-run-startup.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";
import { replaceChatStream, retainPersistedStreamPrefix } from "./stream-causal-boundary.ts";

// History recovery shares the cold tool reducer; the live dispatcher keeps its own pane boundary.
export { handleAgentEvent } from "./tool-stream.ts";

function resolveInFlightAssistantText(bufferedText: unknown): string | null {
  return typeof bufferedText === "string" &&
    bufferedText &&
    !isHiddenAssistantStreamText(bufferedText)
    ? bufferedText
    : null;
}

export function applyHistoryInFlightRun(params: ChatHistoryRunApplication): void {
  const {
    state,
    run,
    messages,
    replayProgress,
    sessionInfo,
    historyRun,
    previousRunProjections,
    runProjectionsBeforeApply,
    currentRunProjections,
    resetStream,
  } = params;
  const inFlightRunId = run?.runId?.trim();
  if (!inFlightRunId || !run) {
    return;
  }
  const projectedInFlightRun = currentRunProjections[inFlightRunId];
  const sameRunContinued =
    state.chatRunId === inFlightRunId &&
    projectedInFlightRun?.status === "streaming" &&
    runProjectionsUnchanged(previousRunProjections, currentRunProjections, inFlightRunId);
  const activeRunIds = sessionInfo?.activeRunIds;
  const inFlightRunIsActive =
    isSessionRunStateActive(sessionInfo ?? {}) &&
    (!Array.isArray(activeRunIds) || activeRunIds.includes(inFlightRunId)) &&
    (!projectedInFlightRun || projectedInFlightRun.status === "streaming");
  // Only a read issued while this pane still owned the old run can replace it.
  // The exact active set proves that custody ended, not how the old run finished.
  // A copied row, a late shared-read consumer, or a different session is not proof.
  const replacesOwnedRun = Boolean(
    state.chatRunId &&
    state.chatRunId !== inFlightRunId &&
    Array.isArray(activeRunIds) &&
    !activeRunIds.includes(state.chatRunId) &&
    historyRun?.runId === state.chatRunId &&
    historyRun.sessionId === sessionInfo?.sessionId &&
    historyRun.isCurrent() &&
    !hasOtherSendingRun(state, inFlightRunId),
  );
  const canAdoptInFlightRun =
    inFlightRunIsActive &&
    ((resetStream &&
      (!state.chatRunId || replacesOwnedRun) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)) ||
      sameRunContinued);
  if (canAdoptInFlightRun) {
    // Canonical run projections change on every live delta or terminal.
    // Their identity fences ABA races where a run starts and finishes while
    // history is pending; the same live run retains its ordered text baseline.
    adoptStartedChatRun(state, inFlightRunId, Date.now());
    state.chatRunSessionAbortable = run?.sessionAbortable === true;
  }
  if (!inFlightRunIsActive || state.chatRunId !== inFlightRunId) {
    return;
  }
  const snapshotStartedAt =
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) ? run.startedAt : null;
  const advancedDuringRead =
    previousRunProjections[inFlightRunId]?.messageRevision !==
    runProjectionsBeforeApply[inFlightRunId]?.messageRevision;
  const source = run.textFromMessage;
  const persisted = Array.isArray(source)
    ? source.map((index) => extractText(messages?.[index])).join("\n\n")
    : source != null && extractText(messages?.[source]);
  const bufferedText = (persisted || "") + (run.text ?? "");
  const usesSnapshotText = replacesOwnedRun || !advancedDuringRead;
  // Prefix receipts index the admitted wire page; a later live revision still wins.
  if (usesSnapshotText) {
    replaceChatStream(state, resolveInFlightAssistantText(bufferedText));
    if (persisted) {
      retainPersistedStreamPrefix(state, persisted);
    }
  } else {
    state.chatStream = resolveInFlightAssistantText(
      extractText(getChatSessionProjection(state).runs[inFlightRunId]?.message),
    );
  }
  state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
  const markObservedActivity = (hasStartup: boolean) => {
    if (
      (bufferedText ||
        (!hasStartup &&
          state.chatRunStartup?.runId !== inFlightRunId &&
          (params.observedRunActivity ?? state.knownAgentRunIds?.has(inFlightRunId)))) &&
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
