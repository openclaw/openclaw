import { formatUiError } from "../../lib/format-error.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "../../lib/sessions/navigation.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import { requestChatAbort } from "./chat-abort-request.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { resetChatHistoryProjection, setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { getChatPendingInputs, mutateChatPendingInput } from "./chat-pending-inputs.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import type { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import {
  captureChatComposerReplacement,
  loadChatComposerState,
  persistChatComposerState,
} from "./composer-draft-storage.ts";
import { chatAttachmentDraftSignature } from "./composer-draft.ts";
import { isIncognitoComposerScope } from "./composer-persistence-state.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";
import type { SessionSnapshotInvalidationReason } from "./session-snapshot-invalidation-events.ts";

export function cancelPendingQueuedChatInput(state: ChatHistoryHost, id: string): boolean {
  const view = getChatPendingInputs(state);
  const cancelled = view?.page.items.find(
    (item) =>
      `pending-input:${item.id}` === id &&
      item.state === "cancelled" &&
      item.endCause === "revoked",
  );
  if (cancelled) {
    void mutateChatPendingInput(state, { kind: "dismiss", inputId: cancelled.id });
    return true;
  }
  const input = view?.queuedInputs.find(
    (item) => `pending-input:${item.id}` === id && item.queued && item.state === "queued",
  );
  const client = state.client;
  if (!view || !input?.runId) {
    return false;
  }
  if (!client || !state.connected || view.cancelling?.has(input.id)) {
    return true;
  }
  const cancelling = (view.cancelling ??= new Set());
  cancelling.add(input.id);
  chatRunPresentation(state).publish();
  const connectionIsCurrent = captureChatConnectionOwner(state);
  const current = () => getChatPendingInputs(state) === view && connectionIsCurrent();
  void requestChatAbort(client, {
    sessionKey: view.sessionKey,
    agentId: view.agentId,
    runId: input.runId,
    ...(isIncognitoComposerScope(state, view) ? {} : { discardPendingInput: true }),
  })
    .then(async (result) => {
      if (!current()) {
        return;
      }
      if (!result.ok) {
        state.chatError = formatUiError(result.error);
        return;
      }
      await loadChatHistory(state, { supersedeInFlight: true });
    })
    .finally(() => {
      cancelling.delete(input.id);
      if (getChatPendingInputs(state) === view) {
        chatRunPresentation(state).publish();
      }
    });
  return true;
}

type RewindChatHistoryState = ChatHistoryHost &
  Parameters<typeof persistChatComposerState>[0] &
  Parameters<typeof scheduleChatScroll>[0] & {
    handleChatDraftChange: (next: string, mentions?: ChatState["chatMentions"]) => void;
    sessions: Pick<SessionCapability, "rewind">;
  };

type SwitchChatHistoryBranchState = ChatHistoryHost &
  Parameters<typeof scheduleChatScroll>[0] & {
    sessions: Pick<SessionCapability, "listBranches" | "switchBranch">;
  };

export function clearCachedChatMessagesForSession(
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

export function captureChatHistoryView(
  state: ChatState,
  sessionKey = state.sessionKey,
  agentParams = scopedAgentParamsForSession(state, sessionKey),
) {
  const sameConnection = captureChatConnectionOwner(state, false);
  const connectionIsCurrent = () => state.connected && sameConnection();
  const viewMatches = () => visibleSessionMatches(state, sessionKey, agentParams.agentId);
  const sameView = () => sameConnection() && viewMatches();
  const viewIsCurrent = () => state.connected && sameView();
  return { sessionKey, agentParams, connectionIsCurrent, viewMatches, sameView, viewIsCurrent };
}

export async function rewindChatHistory(
  state: RewindChatHistoryState,
  entryId: string,
  attachmentReads: Pick<ChatAttachmentReadLifecycle, "abortReads" | "readSignal">,
): Promise<{ editorText?: string } | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const { sessionKey, agentParams, connectionIsCurrent, viewMatches, viewIsCurrent } =
    captureChatHistoryView(state);
  const readComposer = () =>
    chatAttachmentDraftSignature(
      state.chatMessage,
      state.chatAttachments,
      state.chatGoalDraftMode,
      state.chatMentions,
      state.chatReplyTarget,
    );
  const composerSignature = readComposer();
  const attachmentReadSignal = attachmentReads.readSignal;
  const ownsComposer = captureChatComposerReplacement(state, sessionKey, agentParams.agentId);
  try {
    const result = await state.sessions.rewind(sessionKey, entryId, agentParams);
    const editorText = result.editorText ?? "";
    clearCachedChatMessagesForSession(state, sessionKey, agentParams.agentId, "cache-eviction");
    // The restored prompt is the user's next action, so every exit refills the
    // composer first and reloads the transcript after.
    const reload = async () => {
      if (!viewMatches()) {
        return;
      }
      const entries = getChatSessionProjection(state).entries;
      const rewindIndex = entries.findIndex((entry) => entry.identity?.id === entryId);
      const retainedHistory = entries
        .slice(0, Math.max(0, rewindIndex))
        .filter((entry) => !entry.pending)
        .map((entry) => entry.message);
      resetChatHistoryProjection(state, agentParams.agentId, retainedHistory);
      await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    };
    // Rewind commits history independently; only its unchanged composer package
    // receives the restored prompt.
    if (!connectionIsCurrent() || !ownsComposer() || readComposer() !== composerSignature) {
      await reload();
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
      await reload();
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
    await reload();
    return result;
  } catch (error) {
    if (viewIsCurrent()) {
      setChatError(state, formatUiError(error));
      scheduleChatScroll(state);
    }
    return null;
  }
}

export async function switchChatHistoryBranch(
  state: SwitchChatHistoryBranchState,
  leafEntryId: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const { sessionKey, agentParams, viewMatches, viewIsCurrent } = captureChatHistoryView(state);
  try {
    await state.sessions.switchBranch(sessionKey, leafEntryId, agentParams);
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
