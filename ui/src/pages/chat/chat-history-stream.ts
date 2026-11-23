import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import type { ChatHistoryResult, ObservedChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  isChatRunStartupPhase,
  isChatRunRecoveryStatus,
  reconcileChatRunStartup,
} from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
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
import {
  knownStreamCausalInterval,
  replaceChatStream,
  retainPersistedStreamPrefix,
} from "./stream-causal-boundary.ts";
import { materializeVisibleStreamState } from "./stream-reconciliation.ts";
import { extractToolMessageRefs } from "./tool-stream-identity.ts";
import type { handleAgentEvent } from "./tool-stream.ts";

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
    isHiddenAssistantMessage: isAssistantHeartbeatAckForDisplay,
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

/** Replay the run's progress, then retire only text identified by its native tool boundary. */
function replayHistoryProgress(
  state: ChatState,
  run: NonNullable<ChatHistoryResult["inFlightRun"]>,
  snapshotText = "",
  replay?: typeof handleAgentEvent,
) {
  const { runId, events } = run;
  const toolStarts = events && new Map<string, number>();
  for (const event of events ?? []) {
    if (event.runId !== runId) {
      continue;
    }
    // The pane owns both the adopted run and its live tool state.
    replay?.(state as never, event, "history");
    const { phase, toolCallId, textLengthBeforeTool } = event.data;
    if (event.stream === "tool" && phase === "start" && typeof toolCallId === "string") {
      toolStarts?.set(
        toolCallId,
        typeof textLengthBeforeTool === "number" ? textLengthBeforeTool : 0,
      );
    }
  }
  const messages = state.chatMessages;
  if (toolStarts?.size === 0 || (!snapshotText && !state.chatStreamSegments.length)) {
    return;
  }
  const interval = knownStreamCausalInterval(messages, runId);
  if (!interval) {
    return;
  }
  const imported = new Map<string, string>();
  let covered = 0;
  let preamble = "";
  for (const message of messages.slice(interval.start, interval.end)) {
    const identity = readSessionMessageIdentity(message);
    if (
      asOptionalRecord(message)?.provider !== "claude-cli" ||
      !identity?.isImported ||
      identity.role !== "assistant" ||
      (identity.runId && identity.runId !== runId)
    ) {
      preamble = "";
      continue;
    }
    const text = extractText(message)?.trim();
    if (text) {
      preamble = preamble ? preamble + "\n\n" + text : text;
    }
    const [call] = extractToolMessageRefs(message);
    if (!call) {
      continue;
    }
    const end = toolStarts?.get(call.id);
    if (preamble && (!toolStarts || end !== undefined)) {
      imported.set(call.id, preamble);
      // A later reply can start with exactly the same words. Only cover bytes already at this call.
      if (
        end &&
        end > covered &&
        end <= snapshotText.length &&
        snapshotText.slice(covered, end).trim() === preamble
      ) {
        covered = end;
      }
    }
    preamble = "";
  }
  if (!imported.size) {
    return;
  }
  // A checkpoint without progress may cover a complete, distinct tool-delimited sequence, never just a matching opening.
  if (!events && !preamble) {
    const texts = [...imported.values()];
    if (new Set(texts).size > 1 && texts.join("\n\n") === snapshotText) {
      covered = snapshotText.length;
    }
  }
  const prefix = snapshotText.slice(0, covered);
  const keepPrefix = prefix && state.chatStream?.startsWith(prefix);
  const parts = state.chatStreamSegments.filter(({ runId: owner, toolCallId, itemId, text }) => {
    const native = toolCallId && imported.get(toolCallId);
    if (owner !== runId || !native) {
      return true;
    }
    return itemId
      ? native !== text.trim() || !imported.delete(toolCallId)
      : !keepPrefix || !prefix.startsWith(text);
  });
  if (
    keepPrefix &&
    !parts.some((part) => part.persisted && part.runId === runId && part.text === prefix)
  ) {
    parts.push({
      runId,
      text: prefix,
      ts: state.chatStreamStartedAt ?? Date.now(),
      persisted: true,
    });
  } else if (parts.length === state.chatStreamSegments.length) {
    return;
  }
  state.chatStreamSegments = parts;
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
  state: ChatState,
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
  replayAgentEvent?: typeof handleAgentEvent,
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
  const sameRunContinued =
    state.chatRunId === inFlightRunId &&
    projectedInFlightRun?.status === "streaming" &&
    runProjectionsUnchanged(previousRunProjections, currentRunProjections, inFlightRunId);
  const activeRunIds = Array.isArray(sessionInfo?.activeRunIds)
    ? sessionInfo.activeRunIds
    : undefined;
  const inFlightRunIsActive =
    isSessionRunStateActive(sessionInfo ?? {}) &&
    (!activeRunIds || activeRunIds.includes(inFlightRunId)) &&
    (!projectedInFlightRun || projectedInFlightRun.status === "streaming");
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
    state.chatRunSessionAbortable = run.sessionAbortable === true;
  }
  if (!inFlightRunIsActive || state.chatRunId !== inFlightRunId) {
    return;
  }
  const snapshotStartedAt = asFiniteNumber(run.startedAt);
  const persisted = run.textFromMessage != null && extractText(messages?.[run.textFromMessage]);
  const bufferedText = (persisted || "") + (run.text ?? "");
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
    replaceChatStream(state, resolveInFlightAssistantText(bufferedText));
    if (persisted) {
      retainPersistedStreamPrefix(state, persisted);
    }
  }
  state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
  const startup = run.events?.findLast(
    (event) => event.runId === inFlightRunId && event.stream === "run_status",
  );
  const startupPhase = startup?.data.phase;
  if (
    (bufferedText ||
      (!startup &&
        state.chatRunStartup?.runId !== inFlightRunId &&
        (observedRunActivity ?? state.knownAgentRunIds?.has(inFlightRunId)))) &&
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
  if (state.chatRunId === run.runId) {
    replayHistoryProgress(state, run, bufferedText, replayAgentEvent);
  }
}
