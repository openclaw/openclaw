import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "../../lib/sessions/navigation.ts";
import { requestChatAbort } from "./chat-abort-request.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import type { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { captureChatComposerReplacement } from "./composer-draft-storage.ts";
import type { persistChatComposerState } from "./composer-draft-storage.ts";
import { chatAttachmentDraftSignature } from "./composer-draft.ts";
import { isIncognitoComposerScope } from "./composer-persistence-state.ts";
import type { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

export function cancelPendingQueuedChatInput(state: ChatHistoryHost, id: string): boolean {
  const view = getChatPendingInputs(state);
  const input = view?.queuedInputs.find(
    (item) => `pending-input:${item.id}` === id && item.queued && item.state === "queued",
  );
  const client = state.client;
  if (!view || !input?.runId) {
    return false;
  }
  if (!client || !state.connected) {
    return true;
  }
  const connectionIsCurrent = captureChatConnectionOwner(state);
  const current = () => getChatPendingInputs(state) === view && connectionIsCurrent();
  void requestChatAbort(client, {
    sessionKey: view.sessionKey,
    agentId: view.agentId,
    runId: input.runId,
    ...(isIncognitoComposerScope(state, view) ? {} : { discardPendingInput: true }),
  }).then(async (result) => {
    if (!current()) {
      return;
    }
    if (!result.ok) {
      state.chatError = formatUiError(result.error);
      return;
    }
    await loadChatHistory(state, { supersedeInFlight: true });
  });
  return true;
}

export type ClearChatHistoryState = ChatHistoryHost &
  Parameters<typeof reconcileChatRunLifecycle>[0] &
  Parameters<typeof scheduleChatScroll>[0] & {
    sessions: Pick<SessionCapability, "reset">;
  };

export type ClearChatHistoryResult = "completed" | "failed" | "uncertain";

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
  let sessionId = state.currentSessionId;
  // Loading may cross a same-key reset. Bind an initially unknown identity once
  // observed, but keep post-issued reset reconciliation scoped to the logical view.
  const canIssue = () => {
    if (!viewIsCurrent()) {
      return false;
    }
    sessionId ??= state.currentSessionId;
    return !sessionId || state.currentSessionId === sessionId;
  };
  return {
    sessionKey,
    agentParams,
    connectionIsCurrent,
    viewMatches,
    sameView,
    viewIsCurrent,
    canIssue,
  };
}

// Capture the operation before loading. A cold action must not acquire a newer
// route, draft or run while its implementation is downloading.
async function loadChatHistoryActions(
  state: ChatState & Parameters<typeof scheduleChatScroll>[0],
  view: ReturnType<typeof captureChatHistoryView>,
) {
  try {
    const {
      clearChatHistory: clear,
      rewindChatHistory: rewind,
      switchChatHistoryBranch: switchBranch,
    } = await import("./chat-history-actions.runtime.ts");
    return view.canIssue()
      ? {
          clearChatHistory: clear,
          rewindChatHistory: rewind,
          switchChatHistoryBranch: switchBranch,
        }
      : null;
  } catch (error) {
    if (view.canIssue()) {
      setChatError(state, formatUiError(error));
      scheduleChatScroll(state);
    }
    return null;
  }
}

function captureClearChatHistory(state: ClearChatHistoryState) {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const view = captureChatHistoryView(state);
  return {
    state,
    client,
    view,
    sessions: state.sessions,
    connectionEpoch: state.connectionEpoch,
    runId: state.chatRunId,
    initialSubmission: state.chatSubmissions?.readInitial(view.sessionKey, client),
    hadActiveRun: hasAbortableChatSessionRun(state),
  };
}
export type ClearChatHistoryOperation = NonNullable<ReturnType<typeof captureClearChatHistory>>;

export async function clearChatHistory(
  state: ClearChatHistoryState,
): Promise<ClearChatHistoryResult> {
  const operation = captureClearChatHistory(state);
  if (!operation) {
    return "failed";
  }
  const actions = await loadChatHistoryActions(state, operation.view);
  return actions ? actions.clearChatHistory(operation) : "failed";
}

function captureRewindChatHistory(
  state: RewindChatHistoryState,
  entryId: string,
  attachmentReads: Pick<ChatAttachmentReadLifecycle, "abortReads" | "readSignal">,
) {
  const view = captureChatHistoryView(state);
  const readComposer = () =>
    chatAttachmentDraftSignature(
      state.chatMessage,
      state.chatAttachments,
      state.chatGoalDraftMode,
      state.chatMentions,
      state.chatReplyTarget,
    );
  return {
    state,
    entryId,
    attachmentReads,
    view,
    readComposer,
    sessions: state.sessions,
    composerSignature: readComposer(),
    attachmentReadSignal: attachmentReads.readSignal,
    ownsComposer: captureChatComposerReplacement(state, view.sessionKey, view.agentParams.agentId),
  };
}
export type RewindChatHistoryOperation = ReturnType<typeof captureRewindChatHistory>;

export async function rewindChatHistory(
  state: RewindChatHistoryState,
  entryId: string,
  attachmentReads: Pick<ChatAttachmentReadLifecycle, "abortReads" | "readSignal">,
): Promise<{ editorText?: string } | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const operation = captureRewindChatHistory(state, entryId, attachmentReads);
  const actions = await loadChatHistoryActions(state, operation.view);
  return actions ? actions.rewindChatHistory(operation) : null;
}

function captureSwitchChatHistory(state: SwitchChatHistoryBranchState, leafEntryId: string) {
  return { state, leafEntryId, sessions: state.sessions, view: captureChatHistoryView(state) };
}
export type SwitchChatHistoryOperation = ReturnType<typeof captureSwitchChatHistory>;

export async function switchChatHistoryBranch(
  state: SwitchChatHistoryBranchState,
  leafEntryId: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const operation = captureSwitchChatHistory(state, leafEntryId);
  const actions = await loadChatHistoryActions(state, operation.view);
  return actions ? actions.switchChatHistoryBranch(operation) : false;
}
