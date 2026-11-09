import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatRunOwner,
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";
import {
  type ChatHistoryRunObservation,
  reconcileChatRunFromSessionRow,
  setChatRunError,
} from "./run-lifecycle.ts";
import { materializeVisibleStreamState } from "./stream-reconciliation.ts";
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

export function runProjectionsUnchanged(
  previous: RunObservations,
  current: RunObservations,
  exceptRunId?: string,
): boolean {
  return (
    Object.entries(previous).every(
      ([id, run]) => id === exceptRunId || current[id]?.revision === run.revision,
    ) &&
    Object.entries(current).every(
      ([id, run]) => id === exceptRunId || previous[id]?.revision === run.revision,
    )
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

type RunObservations = Readonly<Record<string, { revision?: symbol; messageRevision?: symbol }>>;

export function readRunProjections(
  state: ChatState,
  sessionKey: string,
  agentId?: string,
): RunObservations {
  const runs = getChatSessionProjection(
    state,
    readChatSessionProjectionScope(state, {
      sessionKey,
      ...(agentId ? { agentId } : {}),
    }),
  ).runs;
  // Pending history must not own the previous payload graph. Semantic tokens
  // fence accepted activity while a residency-only release remains invisible.
  return Object.fromEntries(
    Object.entries(runs).map(([id, run]) => [
      id,
      {
        revision: run.revision,
        messageRevision: run.messageRevision,
      },
    ]),
  );
}

export type ChatHistoryRunApplication = {
  state: ChatState;
  run: ChatHistoryResult["inFlightRun"];
  observedRunActivity?: boolean;
  sessionInfo: GatewaySessionRow | undefined;
  historyRun: ChatHistoryRunObservation | undefined;
  previousRunProjections: RunObservations;
  runProjectionsBeforeApply: RunObservations;
  currentRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  resetStream: boolean;
  replayAgentEvent: typeof handleAgentEvent | undefined;
};

export function hasOtherSendingRun(state: ChatState, runId: string): boolean {
  return state.chatQueue.some(
    (item) => item.sendState === "sending" && item.sendRunId && item.sendRunId !== runId,
  );
}

export function applyHistoryTerminalRun(params: ChatHistoryRunApplication): void {
  const {
    state,
    sessionInfo,
    historyRun,
    previousRunProjections,
    runProjectionsBeforeApply,
    currentRunProjections,
  } = params;
  if (!sessionInfo) {
    return;
  }
  const localRunId = state.chatRunId?.trim();
  if (
    localRunId &&
    sessionInfo.lastRunId !== localRunId &&
    historyRun &&
    !hasOtherSendingRun(state, localRunId) &&
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
    !isSessionRunStateActive(sessionInfo) &&
    (!state.chatRunId || state.chatRunId === terminalRunId) &&
    !hasOtherSendingRun(state, terminalRunId) &&
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
}
