import { lazyModule } from "solid-js";
import { t } from "../../i18n/index.ts";
import {
  captureOlderHistoryClaim,
  chatHistoryBoundarySelector,
  chatHistoryOlderSelector,
} from "./chat-history-request.ts";
import { acceptsHistoryResult, setChatError } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatInputHistoryRound, ChatInputHistoryState } from "./input-history.ts";

const olderPrompts = lazyModule(() => import("./input-history-older.ts"));

export function extendInputHistory(
  state: ChatState & ChatInputHistoryState,
  round: ChatInputHistoryRound,
) {
  if (round.older?.current()) {
    return round.older.next();
  }
  round.older?.cancel();
  const client = state.client;
  const selector = client && state.connected ? chatHistoryOlderSelector(state) : null;
  const hasPrefix = () =>
    round.firstMessage !== state.chatMessages[0] && state.chatMessages.includes(round.firstMessage);
  if (!selector && !hasPrefix()) {
    return null;
  }
  const claim = client && captureOlderHistoryClaim(state, client);
  const pagination = state.chatHistoryPagination;
  const sessionId = state.currentSessionId;
  const cursor = {
    selector,
    boundaryId: selector && "messageId" in selector ? selector.messageId : undefined,
  };
  const current = () =>
    state.currentSessionId === sessionId &&
    state.chatHistoryPagination === pagination &&
    (!claim || acceptsHistoryResult(state, claim)) &&
    (!cursor.boundaryId || chatHistoryBoundarySelector(state)?.messageId === cursor.boundaryId);
  let pending: { controller: AbortController; result: Promise<"up" | null> } | undefined;
  const older = {
    current,
    hasMore: () => Boolean(pending || cursor.selector),
    cancel() {
      pending?.controller.abort();
      pending = undefined;
    },
    next() {
      if (pending) {
        return pending.result;
      }
      if (!cursor.selector && !hasPrefix()) {
        return null;
      }
      const controller = new AbortController();
      const draft = state.chatMessage;
      const accepts = () =>
        !controller.signal.aborted &&
        state.chatInputHistory === round &&
        !state.chatLoading &&
        state.chatMessage === draft &&
        state.sessionKey === round.sessionKey &&
        current();
      const result = olderPrompts()
        .then(
          ({ recallOlderInput }) =>
            recallOlderInput(state, round, claim, cursor, sessionId, controller.signal, accepts),
          () => {
            if (accepts()) {
              setChatError(state, (state.recallError = t("lazyView.staleSubtitle")));
            }
            return null;
          },
        )
        .finally(() => {
          if (pending?.controller === controller) {
            pending = undefined;
          }
        });
      pending = { controller, result };
      return result;
    },
  };
  round.older = older;
  return older.next();
}
