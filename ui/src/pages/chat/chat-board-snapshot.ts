import { chatHistoryRequests } from "./chat-history-state.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

type ChatMessageCacheHost = Parameters<typeof cacheChatSessionSnapshot>[1];
type ChatMessageCacheTarget = Parameters<typeof cacheChatSessionSnapshot>[2];

function cacheChatBoardSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  snapshot: unknown,
  receivedAtMs: number,
  savedHeights?: Record<string, number>,
): void {
  const existing = readChatSessionSnapshot(cache, host, target);
  const contentHeights = savedHeights ?? existing?.board?.contentHeights;
  if (
    snapshot !== null
      ? existing?.board?.snapshot === snapshot && existing?.board?.contentHeights === contentHeights
      : existing?.board === null
  ) {
    return;
  }
  cacheChatSessionSnapshot(cache, host, target, {
    ...(existing ?? { messages: [], pagination: { hasMore: false }, sessionId: null }),
    board: snapshot !== null ? { snapshot, receivedAtMs, contentHeights } : null,
  });
}

export function cacheChatBoardContentHeightAfterHydration(
  host: ChatMessageCacheHost & { chatMessagesBySession: ChatMessageCache },
  target: ChatMessageCacheTarget,
  key: string,
  height: number,
  isCurrent: () => boolean,
): void {
  afterHydration(host, () => {
    if (!isCurrent()) {
      return;
    }
    const cache = host.chatMessagesBySession;
    const existing = readChatSessionSnapshot(cache, host, target);
    if (
      !existing?.board ||
      existing.board.contentHeights?.[key] === height ||
      height < 1 ||
      height > 20000
    ) {
      return;
    }
    const contentHeights = Object.fromEntries(
      [
        ...Object.entries(existing.board.contentHeights ?? {}).filter(([entry]) => entry !== key),
        [key, height] as const,
      ].slice(-48),
    );
    cacheChatSessionSnapshot(cache, host, target, {
      ...existing,
      board: { ...existing.board, contentHeights },
    });
  });
}

export function cacheChatBoardSnapshotAfterHydration(
  host: ChatMessageCacheHost & { chatMessagesBySession: ChatMessageCache },
  target: ChatMessageCacheTarget,
  snapshot: unknown,
  receivedAtMs: number,
  isCurrent: () => boolean,
): void {
  afterHydration(host, () => {
    if (isCurrent()) {
      cacheChatBoardSnapshot(host.chatMessagesBySession, host, target, snapshot, receivedAtMs);
    }
  });
}

function afterHydration(host: ChatMessageCacheHost, persist: () => void): void {
  // A board write must not invalidate the transcript read sharing this record.
  const hydration = chatHistoryRequests(host).initialSnapshotHydration;
  if (hydration) {
    void hydration.promise.then(persist);
  } else {
    persist();
  }
}

export function mergeStoredChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  stored: ChatSessionSnapshot | null,
): ChatSessionSnapshot | null {
  const cached = readChatSessionSnapshot(cache, host, target);
  const board = cached?.board === undefined ? stored?.board : cached.board;
  // A board can arrive before history; its empty envelope must not hide stored rows.
  const snapshot =
    stored && cached?.sessionId === null && cached.messages.length === 0
      ? stored
      : (cached ?? stored);
  if (board) {
    cacheChatBoardSnapshot(
      cache,
      host,
      target,
      board.snapshot,
      board.receivedAtMs,
      board.contentHeights,
    );
  }
  return snapshot && board !== undefined ? { ...snapshot, board } : snapshot;
}
