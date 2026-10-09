import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  isHiddenAssistantStreamText,
  shouldHideAssistantChatMessage,
} from "../../lib/chat/message-visibility.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { isChatRunStartupPhase, reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatRunOwner,
  getChatSessionProjection,
  observeChatRunModel,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";
import {
  adoptStartedChatRun,
  type ChatHistoryRunObservation,
  reconcileChatRunFromSessionRow,
  setChatRunError,
} from "./run-lifecycle.ts";
import { replaceChatStream } from "./stream-causal-boundary.ts";
import { materializeVisibleStreamState } from "./stream-reconciliation.ts";
import { handleAgentEvent } from "./tool-stream.ts";

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
    persistCommentary: opts.persistCommentary ?? persistsChatCommentary(state),
    isHiddenAssistantMessage: shouldHideAssistantChatMessage,
    isHiddenStreamText: isHiddenAssistantStreamText,
  });
}

export function persistsChatCommentary(state: ChatState): boolean {
  return state.settings?.chatPersistCommentary !== false;
}

function resolveInFlightAssistantText(bufferedText: unknown): string | null {
  return typeof bufferedText === "string" &&
    bufferedText &&
    !isHiddenAssistantStreamText(bufferedText)
    ? bufferedText
    : null;
}

function runProjectionsUnchanged(
  previous: ReturnType<typeof getChatSessionProjection>["runs"],
  current: ReturnType<typeof getChatSessionProjection>["runs"],
  exceptRunId?: string,
): boolean {
  return (
    Object.entries(previous).every(([id, run]) => id === exceptRunId || current[id] === run) &&
    Object.entries(current).every(([id, run]) => id === exceptRunId || previous[id] === run)
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
    readChatSessionProjectionScope(state, {
      sessionKey,
      ...(agentId ? { agentId } : {}),
    }),
  ).runs;
}

export function applyHistoryRun(params: {
  state: ChatState;
  run: ChatHistoryResult["inFlightRun"];
  sessionInfo: GatewaySessionRow | undefined;
  historyRun: ChatHistoryRunObservation | undefined;
  previousRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  runProjectionsBeforeApply: ReturnType<typeof getChatSessionProjection>["runs"];
  currentRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  resetStream: boolean;
}): void {
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
  const hasOtherSendingRun = (runId: string) =>
    state.chatQueue.some(
      (item) => item.sendState === "sending" && item.sendRunId && item.sendRunId !== runId,
    );
  const inFlightRunId = run?.runId?.trim();
  if (!inFlightRunId || !run) {
    if (!sessionInfo) {
      return;
    }
    const localRunId = state.chatRunId?.trim();
    if (
      localRunId &&
      sessionInfo.lastRunId !== localRunId &&
      historyRun &&
      !hasOtherSendingRun(localRunId) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply) &&
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
      !isSessionRunActive(sessionInfo) &&
      (!state.chatRunId || state.chatRunId === terminalRunId) &&
      !hasOtherSendingRun(terminalRunId) &&
      ((sessionInfo.status !== "killed" && !knownRun) ||
        state.chatRunId === terminalRunId ||
        getChatRunOwner(state) === terminalRunId) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)
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
  const sameRunContinued =
    state.chatRunId === inFlightRunId &&
    projectedInFlightRun?.status === "streaming" &&
    runProjectionsUnchanged(previousRunProjections, currentRunProjections, inFlightRunId);
  const activeRunIds = sessionInfo?.activeRunIds;
  const inFlightRunIsActive =
    isSessionRunActive(sessionInfo ?? {}) &&
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
    !hasOtherSendingRun(inFlightRunId),
  );
  const canAdoptInFlightRun =
    inFlightRunIsActive &&
    ((resetStream &&
      (!state.chatRunId || replacesOwnedRun) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)) ||
      sameRunContinued);
  if (canAdoptInFlightRun) {
    const recoveringRun = state.chatRunId !== inFlightRunId;
    // Canonical run projections change on every live delta or terminal.
    // Their identity fences ABA races where a run starts and finishes while
    // history is pending; the same live run retains its ordered text baseline.
    adoptStartedChatRun(state, inFlightRunId, Date.now());
    if (recoveringRun && sessionInfo) {
      observeChatRunModel(state, inFlightRunId, sessionInfo);
    }
    state.chatRunSessionAbortable = run?.sessionAbortable === true;
  }
  if (!inFlightRunIsActive || state.chatRunId !== inFlightRunId) {
    return;
  }
  const snapshotStartedAt =
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) ? run.startedAt : null;
  const advancedDuringRead =
    previousRunProjections[inFlightRunId]?.message !==
    runProjectionsBeforeApply[inFlightRunId]?.message;
  // Ordered live frames already establish their baseline, including shrinking
  // replacements. A pending history snapshot cannot extend that baseline by text.
  if (advancedDuringRead && !replacesOwnedRun) {
    state.chatStream = resolveInFlightAssistantText(
      extractText(runProjectionsBeforeApply[inFlightRunId]?.message),
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
    run.text &&
    !(state.chatRunStartup?.state === "status" && state.chatRunStartup.phase === "retrying")
  ) {
    reconcileChatRunStartup(state, { state: "activity", runId: inFlightRunId });
  } else if (startup && isChatRunStartupPhase(startupPhase)) {
    reconcileChatRunStartup(state, {
      state: "status",
      runId: inFlightRunId,
      phase: startupPhase,
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
        handleAgentEvent(state as never, event as never);
      }
    }
  }
}
