import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { mergeStoredChatSessionSnapshot } from "./chat-board-snapshot.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { chatHistoryRequests, type InitialChatSnapshotHydration } from "./chat-history-state.ts";
import { ChatPaneReplyNavigation } from "./chat-pane-reply-navigation.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  resolveChatSnapshotKey,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

export abstract class ChatPaneSnapshotHydration extends ChatPaneReplyNavigation {
  protected hydrateStoredChatSnapshot(
    state: NonNullable<ChatPaneSnapshotHydration["state"]>,
    sessionKey: string,
  ): void {
    if (!this.sessionSnapshotStore) {
      return;
    }
    const target = { sessionKey };
    const cache = state.chatMessagesBySession;
    const cacheKey = resolveChatSnapshotKey(state, target);
    const requests = chatHistoryRequests(state);
    const isCurrent = () =>
      requests.initialSnapshotHydration === hydration &&
      this.state === state &&
      this.ownsChatSnapshot(target) &&
      areUiSessionKeysEquivalent(state.sessionKey, sessionKey) &&
      resolveChatSnapshotKey(state, target) === cacheKey;
    const restoreBoard = async (storedBoard: ChatSessionSnapshot["board"]) => {
      let { board = storedBoard } = readChatSessionSnapshot(cache, state, target) ?? {};
      if (!board) {
        return;
      }
      const gateway = this.context.gateway.snapshot;
      if (gateway.client && gateway.phase !== "connected") {
        // Let connect leave before the cached dashboard's first render.
        await gateway.client.initialConnectSent;
        // A live board or removal can supersede the cached receipt while waiting.
        ({ board = storedBoard } = readChatSessionSnapshot(cache, state, target) ?? {});
      }
      if (isCurrent() && board) {
        this.resolveBoardProvider();
        this.boardProviderLease?.restoreSnapshot(board.snapshot, board.receivedAtMs);
      }
    };
    const reading = this.sessionSnapshotStore.read(cacheKey, (board) => {
      void restoreBoard(board);
    });
    const hydration: InitialChatSnapshotHydration = {
      titlePending: true,
      sessionKey,
      connected: this.context.gateway.snapshot.phase === "connected",
      promise: reading
        .then(async (storedSnapshot) => {
          // Let the initial composer commit before the saved rows do their layout work.
          if (!hydration.connected && storedSnapshot && !storedSnapshot.board) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            });
          }
          // Scoped snapshots can paint while the route awaits live revalidation.
          // The pending route still gates commands and authenticated resources.
          if (!isCurrent()) {
            return;
          }
          const snapshot = mergeStoredChatSessionSnapshot(cache, state, target, storedSnapshot);
          const boardRestored = restoreBoard(snapshot?.board);
          if (requests.acceptedHistory || !snapshot) {
            return boardRestored;
          }
          // A sibling can fill the shared cache while this pane still needs its
          // own transcript. Adopt those messages before revalidating their cursor.
          applyChatCacheSnapshot(state, snapshot);
          const mergedSnapshot = { ...snapshot, messages: state.chatMessages };
          cacheChatSessionSnapshot(cache, state, target, mergedSnapshot);
          if (snapshot.progressCard !== undefined) {
            const progressTarget = this.resolveChatReadTarget();
            if (progressTarget) {
              this.progressCards.hydrate(progressTarget, snapshot.progressCard);
            }
          }
          return boardRestored;
        })
        .catch(() => undefined)
        .finally(() => {
          hydration.titlePending = false;
          if (requests.initialSnapshotHydration === hydration) {
            delete requests.initialSnapshotHydration;
          }
        }),
    };
    // The title observes cache readiness; network history never waits on it.
    requests.initialSnapshotHydration = projectChatFields(hydration, ["titlePending"]);
  }
}
