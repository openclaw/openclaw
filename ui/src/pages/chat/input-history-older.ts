import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import {
  nativeHistoryMessageSourceIdentity,
  oldestNativeHistoryMessage,
} from "../../lib/chat/history-message-identity.ts";
import {
  chatHistoryBoundarySelector,
  requestOlderChatHistoryPage,
} from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import { resolveChatHistoryPagination } from "./chat-history-snapshot.ts";
import { setChatError } from "./chat-history-state.ts";
import { requiresChatHistoryReload } from "./chat-history.ts";
import {
  CHAT_INPUT_HISTORY_LIMIT,
  userInput,
  type ChatInputHistoryState,
  type ChatInputHistoryRound,
} from "./input-history.ts";

function appendOlderInputs(items: string[], messages: unknown[], end = messages.length) {
  if (end <= 0) {
    return;
  }
  const known = new Set(items);
  for (let i = end - 1; i >= 0 && items.length < CHAT_INPUT_HISTORY_LIMIT; i--) {
    const text = userInput(asOptionalRecord(messages[i]));
    if (text && !known.has(text)) {
      known.add(text);
      items.push(text);
    }
  }
}

export async function recallOlderInput(
  input: ChatInputHistoryState,
  round: ChatInputHistoryRound,
  index: number,
  signal: AbortSignal,
  current: () => boolean,
): Promise<"up" | null> {
  const { reader, items } = round;
  // The user may cancel while the optional module itself is loading.
  if (!current()) {
    return null;
  }
  for (const key of ["lastError", "chatError"] as const) {
    if (input.recallError && input[key] === input.recallError) {
      input[key] = null;
    }
  }
  input.recallError = undefined;
  const select = (text: string) => {
    round.index = index + 1;
    input.chatMessage = text;
    input.chatMentions = [];
    return "up" as const;
  };
  const messages = input.chatMessages;
  if (round.firstMessage !== messages[0]) {
    appendOlderInputs(items, messages, messages.indexOf(round.firstMessage));
    round.firstMessage = messages[0];
    const next = items[index + 1];
    if (next !== undefined) {
      return select(next);
    }
  }
  if (!reader) {
    return null;
  }
  const { state, claim, sessionId, cursor } = reader;
  try {
    for (let page = 0; page < 3 && cursor.selector; page++) {
      const requested = cursor.selector;
      const boundary =
        "messageId" in requested
          ? nativeHistoryMessageSourceIdentity(oldestNativeHistoryMessage(state.chatMessages))
          : undefined;
      const result = await requestOlderChatHistoryPage(
        claim.client,
        claim.sessionKey,
        claim.agentId,
        requested,
        current,
        signal,
      );
      if (!current()) {
        return null;
      }
      const next = resolveChatHistoryPagination(result);
      if (
        requiresChatHistoryReload(result, sessionId?.trim() ?? "", boundary) ||
        (next.hasMore &&
          (!next.olderCursor || ("cursor" in requested && requested.cursor === next.olderCursor)))
      ) {
        cursor.selector = "cursor" in requested ? chatHistoryBoundarySelector(state) : null;
        cursor.boundaryId = cursor.selector?.messageId;
        throw new Error(t("chat.thread.earlierInterrupted"));
      }
      cursor.selector = next.hasMore && next.olderCursor ? { cursor: next.olderCursor } : null;
      // A boundary probe reopens a cursor; its anchor is not an older prompt.
      if ("cursor" in requested) {
        appendOlderInputs(items, result.messages ?? []);
      }
      const older = items[index + 1];
      if (older !== undefined) {
        return select(older);
      }
    }
  } catch (error) {
    if (current()) {
      setChatError(input, (input.recallError = formatChatHistoryLoadError(error)));
    }
  }
  return null;
}
