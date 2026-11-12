import { retireInitialChatSubmission } from "../../app/chat-submissions.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import type {
  ClearChatHistoryOperation,
  ClearChatHistoryResult,
  ClearChatHistoryState,
  RewindChatHistoryOperation,
  SwitchChatHistoryOperation,
} from "./chat-history-actions.ts";
import { captureChatHistoryView } from "./chat-history-actions.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection, setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { loadChatComposerState, persistChatComposerState } from "./composer-draft-storage.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";
import type { SessionSnapshotInvalidationReason } from "./session-snapshot-invalidation-events.ts";

function clearCachedChatMessagesForSession(
  state: ChatState,
  sessionKey: string,
  agentId?: string,
  reason?: SessionSnapshotInvalidationReason,
) {
  if (!state.chatMessagesBySession) {
    return;
  }
  clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey, agentId }, reason);
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
  operation: ClearChatHistoryOperation,
): Promise<ClearChatHistoryResult> {
  const { state, client, connectionEpoch, view, runId, initialSubmission, hadActiveRun, sessions } =
    operation;
  const { sessionKey, agentParams, sameView: ownsOriginalView } = view;
  if (!view.canIssue()) {
    return "failed";
  }
  try {
    const resetResult = await sessions.reset(sessionKey, agentParams);
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

export async function rewindChatHistory(operation: RewindChatHistoryOperation) {
  const {
    state,
    entryId,
    attachmentReads,
    sessions,
    view,
    readComposer,
    composerSignature,
    attachmentReadSignal,
    ownsComposer,
  } = operation;
  const { sessionKey, agentParams, connectionIsCurrent, viewMatches, viewIsCurrent } = view;
  if (!view.canIssue()) {
    return null;
  }
  try {
    const result = await sessions.rewind(sessionKey, entryId, agentParams);
    const editorText = result.editorText ?? "";
    clearCachedChatMessagesForSession(state, sessionKey, agentParams.agentId, "cache-eviction");
    if (viewMatches()) {
      const entries = getChatSessionProjection(state).entries;
      const index = entries.findIndex((entry) => entry.identity?.id === entryId);
      const retainedHistory = entries
        .slice(0, Math.max(0, index))
        .filter((entry) => !entry.pending && !entry.localOutput)
        .map((entry) => entry.message);
      resetChatHistoryProjection(state, agentParams.agentId, retainedHistory);
      await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    }
    // Rewind commits history independently; only its unchanged composer package
    // may receive the restored prompt after either round trip.
    if (!connectionIsCurrent() || !ownsComposer() || readComposer() !== composerSignature) {
      return null;
    }
    persistChatComposerState(state, sessionKey, {
      agentId: agentParams.agentId,
      draft: editorText,
      mentions: [],
      goalMode: null,
      replyTarget: null,
      expectedDraftRevision: loadChatComposerState(state, sessionKey, agentParams.agentId).revisions
        .committed,
    });
    if (!viewMatches()) {
      return null;
    }
    state.chatGoalDraftMode = null;
    state.chatReplyTarget = null;
    state.chatAttachments = replaceChatAttachmentsFromEditor(
      state.chatAttachments,
      result.editorAttachments,
    );
    state.handleChatDraftChange(editorText, []);
    // Publish the complete restored draft before cancellation notifies the pane.
    if (attachmentReads.readSignal === attachmentReadSignal) {
      attachmentReads.abortReads();
    }
    return result;
  } catch (error) {
    if (viewIsCurrent()) {
      setChatError(state, formatUiError(error));
      scheduleChatScroll(state);
    }
    return null;
  }
}

export async function switchChatHistoryBranch(operation: SwitchChatHistoryOperation) {
  const { state, leafEntryId, sessions, view } = operation;
  const { sessionKey, agentParams, viewMatches, viewIsCurrent } = view;
  if (!view.canIssue()) {
    return false;
  }
  try {
    await sessions.switchBranch(sessionKey, leafEntryId, agentParams);
    clearCachedChatMessagesForSession(state, sessionKey, agentParams.agentId, "cache-eviction");
    if (!viewMatches()) {
      return false;
    }
    resetChatHistoryProjection(state, agentParams.agentId);
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    return viewIsCurrent();
  } catch (error) {
    if (viewIsCurrent()) {
      setChatError(state, formatUiError(error));
      scheduleChatScroll(state);
    }
    return false;
  }
}
