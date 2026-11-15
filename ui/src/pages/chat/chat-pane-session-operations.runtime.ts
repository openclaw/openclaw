import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { setChatError } from "./chat-history-state.ts";
import { preparePaneSessionHandoff } from "./chat-pane-shared.ts";
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
    setChatError(state, t("chat.sendErrors.newSessionBusy"));
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
            ? t("chat.sendErrors.newSessionLoading")
            : t("chat.sendErrors.newSessionFailed")),
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
