import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsRecoverParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { setChatError } from "./chat-history-state.ts";
import type { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { canCreateChatSession } from "./chat-state-route.ts";

type SessionOperation = {
  state: ChatPageHost;
  context: ApplicationContext;
  sessions: ApplicationContext["sessions"];
  paneId: string;
  isCurrent: () => boolean;
  onSessionChange: (nextSessionKey: string) => boolean | void;
};

export async function recoverCapturedChatSession({
  state,
  context,
  sessions,
  paneId,
  isCurrent,
  onSessionChange,
  params,
  sourceSessionKey,
  generation,
  creation,
}: SessionOperation & {
  params: SessionsRecoverParams;
  sourceSessionKey: string;
  generation: number;
  creation: ChatPaneSessionCreation["sessionCreation"];
}): Promise<boolean> {
  if (!isCurrent() || state.sessionKey !== sourceSessionKey) {
    return false;
  }
  const access = readSessionMethodAccess(context.gateway.snapshot, {
    method: "sessions.recover",
    params,
  });
  if (!access.allowed) {
    setChatError(state, access.reason);
    return false;
  }
  const recovery = await sessions.recover(params);
  if (!isCurrent() || state.sessionKey !== sourceSessionKey) {
    return false;
  }
  if (!recovery) {
    setChatError(state, state.sessionsError ?? NEW_SESSION_CREATE_FAILED_MESSAGE);
    return false;
  }
  if (recovery.continuation.status === "rejected") {
    if (
      params.mode === "in-place" &&
      params.sessionId &&
      params.recoveryCycleId &&
      recovery.key === sourceSessionKey &&
      recovery.sessionId === params.sessionId &&
      isRecord(recovery.continuation.error.details) &&
      recovery.continuation.error.details.reason === "restart-safe-tools-unavailable"
    ) {
      creation.restartFallback = {
        key: sourceSessionKey,
        sessionId: params.sessionId,
        recoveryCycleId: params.recoveryCycleId,
        generation,
      };
    }
    setChatError(state, formatUiError(recovery.continuation.error.message));
    return false;
  }
  creation.restartFallback = null;
  const nextSessionKey = recovery.key;
  if (areUiSessionKeysEquivalent(nextSessionKey, sourceSessionKey)) {
    return true;
  }
  if (onSessionChange(nextSessionKey) === false) {
    return false;
  }
  preparePaneSessionHandoff(context, paneId, nextSessionKey, {
    attachments: [],
    draft: "",
  });
  return true;
}

export async function createCapturedChatSession({
  state,
  context,
  sessions,
  paneId,
  isCurrent,
  onSessionChange,
  previousSessionKey,
  expiredIncognito,
  preservesBoard,
  createParams,
  readCreateAccess,
  confirmReset,
  signal,
}: SessionOperation & {
  previousSessionKey: string;
  expiredIncognito: boolean;
  preservesBoard: boolean;
  createParams: Parameters<ApplicationContext["sessions"]["create"]>[0];
  readCreateAccess: () => SessionMethodAccess;
  confirmReset: () => Promise<boolean>;
  signal: AbortSignal;
}): Promise<boolean> {
  if (signal.aborted || !isCurrent() || state.sessionKey !== previousSessionKey) {
    return false;
  }
  if (
    (!expiredIncognito && !(await confirmReset())) ||
    !isCurrent() ||
    !areUiSessionKeysEquivalent(state.sessionKey, previousSessionKey)
  ) {
    return false;
  }
  if (!canCreateChatSession(state)) {
    setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
    return false;
  }
  const currentAccess = readCreateAccess();
  if (!currentAccess.allowed) {
    setChatError(state, currentAccess.reason);
    return false;
  }

  setChatError(state, null);
  if (preservesBoard) {
    const resetResult = await clearChatHistory(state);
    return resetResult !== "failed";
  }
  const nextSessionKey = await sessions.create(createParams, {
    signal,
  });
  if (signal.aborted || !isCurrent()) {
    return false;
  }
  if (!nextSessionKey || state.sessionKey !== previousSessionKey || !canCreateChatSession(state)) {
    if (!nextSessionKey) {
      setChatError(
        state,
        state.sessionsError ??
          (state.sessionsLoading
            ? NEW_SESSION_LIST_LOADING_MESSAGE
            : NEW_SESSION_CREATE_FAILED_MESSAGE),
      );
    }
    return false;
  }
  if (onSessionChange(nextSessionKey) === false) {
    return false;
  }
  preparePaneSessionHandoff(context, paneId, nextSessionKey, {
    attachments: cloneChatAttachmentsForIndependentOwner(state.chatAttachments),
    draft: state.chatMessage,
    ...(state.chatMentions?.length
      ? { mentions: state.chatMentions.map((mention) => ({ ...mention })) }
      : {}),
    ...(state.chatGoalDraftMode ? { goalMode: state.chatGoalDraftMode } : {}),
    ...(state.chatReplyTarget ? { replyTarget: state.chatReplyTarget } : {}),
  });
  return true;
}
