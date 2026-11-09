import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import {
  hasOtherSendingRun,
  runProjectionsUnchanged,
  type ChatHistoryRunApplication,
} from "./chat-history-stream.ts";
import {
  isChatRunStartupPhase,
  isChatRunRecoveryStatus,
  reconcileChatRunStartup,
} from "./chat-run-startup.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";
import { replaceChatStream } from "./stream-causal-boundary.ts";

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
  // Ordered live frames already establish their baseline, including shrinking
  // replacements. A pending history snapshot cannot extend that baseline by text.
  if (advancedDuringRead && !replacesOwnedRun) {
    state.chatStream = resolveInFlightAssistantText(
      extractText(getChatSessionProjection(state).runs[inFlightRunId]?.message),
    );
  } else {
    replaceChatStream(state, resolveInFlightAssistantText(run.text));
  }
  state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
  const startup = run.events?.findLast(
    (event) => event.runId === inFlightRunId && event.stream === "run_status",
  );
  const startupPhase = startup?.data.phase;
  if (
    (run.text ||
      (!startup &&
        state.chatRunStartup?.runId !== inFlightRunId &&
        (params.observedRunActivity ?? state.knownAgentRunIds?.has(inFlightRunId)))) &&
    startupPhase !== "waiting_for_model" &&
    !isChatRunRecoveryStatus(state.chatRunStartup)
  ) {
    reconcileChatRunStartup(state, { state: "activity", runId: inFlightRunId });
  } else if (startup && isChatRunStartupPhase(startupPhase)) {
    reconcileChatRunStartup(state, {
      state: "status",
      runId: inFlightRunId,
      phase: startupPhase,
      ...(startupPhase === "waiting_for_model"
        ? { waitReason: startup.data.reason === "slot" ? ("slot" as const) : ("response" as const) }
        : {}),
      seq: startup.seq,
    });
  }
  // Disconnect cleanup intentionally removes transient activity rows while
  // retaining the owned run. Replay fills that gap; per-identity sequence
  // fences keep a delayed snapshot from replacing newer live progress.
  if (state.chatRunId === run.runId && Array.isArray(run.events)) {
    for (const event of run.events) {
      if (event?.runId === run.runId) {
        // SAFETY: history replays the same agent events against the pane that owns live tool state.
        params.replayAgentEvent?.(state as never, event as never, "history");
      }
    }
  }
}
