import { retireInitialChatSubmission } from "../../app/chat-submissions.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import {
  captureChatHistoryView,
  clearCachedChatMessagesForSession,
} from "./chat-history-actions.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection, setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatHistoryHost } from "./chat-state-contract.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

type ClearChatHistoryState = ChatHistoryHost &
  Parameters<typeof reconcileChatRunLifecycle>[0] &
  Parameters<typeof scheduleChatScroll>[0] & {
    sessions: Pick<SessionCapability, "reset">;
  };

type ClearChatHistoryResult = "completed" | "failed" | "uncertain";

function hasAbortableChatSessionRun(state: ClearChatHistoryState): boolean {
  if (state.chatRunId) {
    return true;
  }
  return Boolean(
    state.sessionsResult?.sessions.some(
      (session) => session.key === state.sessionKey && isSessionRunStateActive(session),
    ),
  );
}

function clearPostResetBranchPrecondition(
  state: ClearChatHistoryState,
  sameView: () => boolean,
  history: ChatHistoryResult | undefined,
) {
  if (
    !history ||
    !Object.hasOwn(history.sessionInfo ?? {}, "activeLeafEntryId") ||
    history.sessionInfo?.activeLeafEntryId !== null ||
    !state.connected ||
    !sameView()
  ) {
    return;
  }
  // Reset can leave old branch metadata visible after the transcript becomes
  // empty. The first post-reset send must establish the new branch itself.
  state.chatDisplayedLeafEntryId = undefined;
}

export async function clearChatHistory(
  state: ClearChatHistoryState,
): Promise<ClearChatHistoryResult> {
  if (!state.client || !state.connected) {
    return "failed";
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const { sessionKey, agentParams, sameView: ownsOriginalView } = captureChatHistoryView(state);
  const runId = state.chatRunId;
  const initialSubmission = state.chatSubmissions?.readInitial(sessionKey, client);
  const hadActiveRun = hasAbortableChatSessionRun(state);
  try {
    const resetResult = await state.sessions.reset(sessionKey, agentParams);
    if (resetResult === "not-started") {
      setChatError(
        state,
        "Couldn’t clear the conversation. The Gateway was unavailable before clearing started. Reconnect and try again.",
      );
      scheduleChatScroll(state);
      return "failed";
    }
    // Reset is destructive once issued. Drop the captured session's cached
    // transcript before classifying the result so an ambiguous response cannot
    // expose stale pre-reset history after a route switch.
    if (initialSubmission) {
      retireInitialChatSubmission(initialSubmission);
    }
    clearCachedChatMessagesForSession(state, sessionKey, agentParams.agentId);
    if (
      resetResult === "uncertain" ||
      state.client !== client ||
      state.connectionEpoch !== connectionEpoch ||
      !state.connected
    ) {
      const { sameView: ownsFeedbackView } = captureChatHistoryView(state, sessionKey, agentParams);
      let historyRefreshed = false;
      if (
        state.client &&
        state.connected &&
        visibleSessionMatches(state, sessionKey, agentParams.agentId)
      ) {
        // Do not let a failed refresh keep rendering the transcript that the
        // ambiguous reset may already have destroyed. Clearing first also
        // prevents history loading from preserving a pre-reset optimistic tail.
        resetChatHistoryProjection(state, agentParams.agentId);
        const history = await loadChatHistory(state);
        historyRefreshed = Boolean(history);
        clearPostResetBranchPrecondition(state, ownsOriginalView, history);
      }
      if (ownsFeedbackView()) {
        setChatError(
          state,
          historyRefreshed
            ? "The clear request may have completed. Current history was refreshed; review it before resuming queued messages."
            : "The clear request may have completed. Cached history was cleared, but current history could not be refreshed; reconnect and review it before resuming queued messages.",
        );
        scheduleChatScroll(state);
      }
      // sessions.reset is not idempotent. Treat an uncertain completion as
      // consumed so a durable /clear row cannot erase newer history on retry.
      return "uncertain";
    }
  } catch (err) {
    if (ownsOriginalView()) {
      setChatError(state, formatUiError(err));
      scheduleChatScroll(state);
    }
    return "failed";
  }
  if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
    return "completed";
  }
  resetChatHistoryProjection(state, agentParams.agentId);
  state.chatRunError = null;
  state.chatReplyTarget = null;
  reconcileChatRunLifecycle(state, {
    outcome: hadActiveRun ? "interrupted" : undefined,
    sessionStatus: "killed",
    runId,
    sessionKey,
    clearLocalRun: true,
    clearToolStream: true,
    clearRunStatus: !hadActiveRun,
  });
  const history = await loadChatHistory(state);
  clearPostResetBranchPrecondition(state, ownsOriginalView, history);
  if (ownsOriginalView()) {
    scheduleChatScroll(state);
  }
  return "completed";
}
